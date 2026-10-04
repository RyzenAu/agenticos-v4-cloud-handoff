"""Unit tests for the Hindsight supervisor and provider patch (no services started, synthetic data only).

Run:  D:\\hindsight\\venv\\Scripts\\python.exe -m unittest discover -s scripts/hindsight/tests -p "test_*.py" -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import patch_provider  # noqa: E402
import supervisor as sv  # noqa: E402

CONFIG = HERE.parent / "hindsight.profiles.json"
FAKE_KEY = "synthetic-test-key-" + "x" * 24


class BackoffTests(unittest.TestCase):
    def test_bound_is_five_restarts_in_ten_minutes(self):
        b = sv.Backoff(5, 600, [5, 10, 20, 40, 80])
        delays = [b.next_delay(100.0 + i) for i in range(5)]
        self.assertEqual(delays, [5, 10, 20, 40, 80])
        self.assertIsNone(b.next_delay(106.0), "6th failure inside the window must stop")
        self.assertIsNone(b.next_delay(200.0))

    def test_window_slides(self):
        b = sv.Backoff(5, 600, [5])
        for i in range(5):
            b.next_delay(float(i))
        self.assertIsNone(b.next_delay(10.0))
        self.assertEqual(b.next_delay(700.0, uptime_s=1000), 5.0, "old restarts age out of the window")

    def test_slow_cycles_are_bounded_too(self):
        """Review D1: a 240 s startup hang (grace 240 s + backoff) never hit the 5-per-600 s rate
        window and restarted forever. The consecutive and total caps now stop it."""
        b = sv.Backoff(5, 600, [5, 10, 20, 40, 80], max_attempts=8, attempts_window_s=3600,
                       max_consecutive=5, stable_uptime_s=900)
        t, restarts = 0.0, 0
        while restarts < 1000:
            t += 240  # the startup hang, killed at the 240 s grace
            d = b.next_delay(t, uptime_s=240)
            if d is None:
                break
            restarts += 1
            t += d
        self.assertEqual(restarts, 5)
        self.assertIn("in a row", b.reason)
        self.assertLess(t, 3600)

    def test_intermittent_failures_hit_the_total_cap(self):
        # Crashes that alternate with "stable" runs reset the consecutive count; the total cap
        # (here 4 per hour) still stops a service that keeps dying.
        b = sv.Backoff(5, 600, [5], max_attempts=4, attempts_window_s=3600, max_consecutive=5, stable_uptime_s=900)
        t, restarts = 0.0, 0
        while restarts < 1000:
            up = 900 if restarts % 2 == 0 else 10
            t += up
            d = b.next_delay(t, uptime_s=up)
            if d is None:
                break
            restarts += 1
            t += d
        self.assertEqual(restarts, 4)
        self.assertIn("restarts within 3600", b.reason)


class DiagnosticsTests(unittest.TestCase):
    def test_error_class_is_name_only(self):
        tail = ("Traceback (most recent call last):\n  File \"x.py\", line 1\n"
                "asyncpg.exceptions.ConnectionDoesNotExistError: SECRET CONTENT about Zebra-7\n"
                "ValueError: another secret message\n")
        self.assertEqual(sv.error_class_from_text(tail), "ValueError")
        self.assertNotIn("SECRET", sv.error_class_from_text(tail))
        self.assertEqual(sv.error_class_from_text("all fine\n"), "none")

    def test_exit_codes(self):
        self.assertEqual(sv.exit_hex(-1), "0xFFFFFFFF")
        self.assertIn("terminated_externally", sv.classify_exit(-1))
        self.assertEqual(sv.classify_exit(0), "clean_exit")
        self.assertIn("native crash", sv.classify_exit(0xC0000005))
        self.assertEqual(sv.classify_exit(None), "unknown")


class ProfileAndEnvTests(unittest.TestCase):
    def setUp(self):
        self.pilot = sv.load_profile(CONFIG, "pilot")
        self.synth = sv.load_profile(CONFIG, "synth")

    def test_profiles_are_loopback_and_separate(self):
        self.assertEqual(self.pilot["host"], "127.0.0.1")
        self.assertEqual(self.pilot["port"], 8888)
        self.assertEqual(self.synth["port"], 8889)
        self.assertNotEqual(self.synth["db"]["data_dir"], self.pilot["db"]["data_dir"])
        self.assertNotEqual(self.synth["db"]["port"], self.pilot["db"]["port"])
        self.assertNotEqual(self.synth["db"]["password_file"], self.pilot["db"]["password_file"])
        self.assertNotIn("hindsight-mu", self.synth["db"]["data_dir"])
        self.assertNotEqual(self.synth["key_file"], self.pilot["key_file"])

    def test_non_loopback_host_is_rejected(self):
        raw = json.loads(CONFIG.read_text(encoding="utf-8"))
        raw["profiles"]["pilot"]["host"] = "0.0.0.0"
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.json"
            p.write_text(json.dumps(raw), encoding="utf-8")
            with self.assertRaises(SystemExit):
                sv.load_profile(p, "pilot")

    def test_env_is_allowlisted_and_authenticated(self):
        base = {"PATH": "C:\\Windows", "SYSTEMROOT": "C:\\Windows", "OPENROUTER_API_KEY": "synthetic-or",
                "GROQ_API_KEY": "synthetic-groq", "AWS_SECRET_ACCESS_KEY": "leak-me",
                "HINDSIGHT_API_TENANT_EXTENSION": "evil:Ext", "MU_HINDSIGHT_CLAUDE_OAUTH_TOKEN": "synthetic-token"}
        env = sv.build_api_env(self.pilot, FAKE_KEY, Path("D:/tmp/launch"), base_env=base)
        self.assertNotIn("OPENROUTER_API_KEY", env)  # only reaches the API as its member key
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertEqual(env["HINDSIGHT_API_HOST"], "127.0.0.1")
        self.assertEqual(env["HINDSIGHT_API_TENANT_EXTENSION"],
                         "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension")
        self.assertEqual(env["HINDSIGHT_API_TENANT_API_KEY"], FAKE_KEY)
        self.assertEqual(env["HINDSIGHT_API_MCP_AUTH_TOKEN"], FAKE_KEY)
        # receipts only: trace rows keep provider/model/tokens, prompt/response cut to 1 character
        self.assertEqual(env["HINDSIGHT_API_LLM_TRACE_ENABLED"], "true")
        self.assertEqual(env["HINDSIGHT_API_LLM_TRACE_MAX_CHARS"], "1")
        self.assertEqual(env["HINDSIGHT_API_AUDIT_LOG_ENABLED"], "false")
        self.assertEqual(env["HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION"], "false")
        self.assertEqual(env["HINDSIGHT_API_OPERATION_RETENTION_DAYS"], "1")
        self.assertEqual(env["HF_HUB_OFFLINE"], "1")
        tools = env["HINDSIGHT_API_MCP_ENABLED_TOOLS"].split(",")
        for t in ("delete_bank", "clear_memories", "delete_document", "clear_mental_model", "retain"):
            self.assertNotIn(t, tools)  # async `retain` too: its payload outlives a forget
        # Stage D (REVIEW-STAGE-D B3): MCP clients read only; saves go through AgenticOS' memory API.
        for t in ("sync_retain", "update_memory", "invalidate_memory"):
            self.assertNotIn(t, tools)
        self.assertIn("recall", tools)
        self.assertEqual(env["TEMP"], str(Path("D:/tmp/launch")))
        self.assertEqual(env["HINDSIGHT_CLAUDE_ISOLATION_ROOT"], str(Path("D:/tmp/launch")))
        # chosen chain: OpenRouter DeepSeek (ZDR) -> Groq free -> Codex subscription, failover
        self.assertEqual(env["HINDSIGHT_API_LLM_PROVIDER"], "openrouter")
        self.assertEqual(env["HINDSIGHT_API_LLM_MODEL"], "deepseek/deepseek-v4.1-flash")
        self.assertEqual(env["HINDSIGHT_API_LLM_API_KEY"], "synthetic-or")
        self.assertEqual(json.loads(env["HINDSIGHT_API_LLM_EXTRA_BODY"]),
                         {"provider": {"zdr": True, "data_collection": "deny"}})
        self.assertEqual(env["HINDSIGHT_API_LLM_1_PROVIDER"], "groq")
        self.assertEqual(env["HINDSIGHT_API_LLM_2_PROVIDER"], "openai-codex")
        self.assertEqual(json.loads(env["HINDSIGHT_API_LLM_STRATEGY"]), {"mode": "failover"})
        # the claude token is passed only when the claude-code provider is selected
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", env)
        cc = dict(self.pilot, llm={"chain": [{"provider": "claude-code", "model": "x"}]})
        env2 = sv.build_api_env(cc, FAKE_KEY, Path("D:/tmp/launch"), base_env=base)
        self.assertEqual(env2["CLAUDE_CODE_OAUTH_TOKEN"], "synthetic-token")

    def test_api_env_cannot_override_auth_or_host(self):
        for bad in ("HINDSIGHT_API_TENANT_API_KEY", "HINDSIGHT_API_HOST", "HINDSIGHT_API_MCP_AUTH_TOKEN"):
            p = dict(self.pilot, api_env={bad: "x"})
            with self.assertRaises(SystemExit):
                sv.build_api_env(p, FAKE_KEY, Path("D:/t"), base_env={})
        with self.assertRaises(SystemExit):
            sv.build_api_env(dict(self.pilot, api_env={"OPENAI_API_KEY": "x"}), FAKE_KEY, Path("D:/t"), base_env={})

    def test_key_by_reference(self):
        with tempfile.TemporaryDirectory() as d:
            kf = Path(d) / "k"
            p = dict(self.synth, key_file=str(kf))
            self.assertEqual(sv.resolve_key(p, env={}), (None, "missing"))
            kf.write_text(FAKE_KEY + "\n", encoding="utf-8")
            self.assertEqual(sv.resolve_key(p, env={}), (FAKE_KEY, "file"))
            self.assertEqual(sv.resolve_key(p, env={"HINDSIGHT_SYNTH_API_KEY": "from-env"}),
                             ("from-env", "env:HINDSIGHT_SYNTH_API_KEY"))


class R3Tests(unittest.TestCase):
    """Review R2 fixes: canonical proxy paths, strict routes, daily restart cap, two mutexes."""

    def test_canonical_path_rejects_every_traversal_form(self):
        import urllib.parse
        import proxy as px
        bad = [b"/mcp/b/../../v1/default/banks/x", b"/mcp/b/..%2F..%2Fx", b"/mcp/b/%2e%2e/%2E%2E/x",
               b"/v1/default/banks/b/documents/..", b"/v1/default/banks/b/documents/.%2e", b"/a/./b", b"/a//b",
               b"/a\\..\\b", b"/a%5c..%5cb", b"/a%2fb", b"/mcp/b/;/../x", b"/mcp/b/..;/x", b"/mcp/b/...", b"a/b",
               b"/v1/default/banks/b/documents/%2e%2e"]
        for raw in bad:
            path, why = px.canonical_path(raw, urllib.parse.unquote(raw.decode("latin-1")))
            self.assertIsNone(path, raw)
            self.assertTrue(why)
        for raw in (b"/mcp/mu-shared/", b"/v1/default/banks/mu-shared/documents/mf-0a1b", b"/health"):
            self.assertEqual(px.canonical_path(raw, raw.decode())[0], raw.decode())

    def test_routes_are_strict(self):
        import proxy as px
        self.assertTrue(px.MCP_PATH.match("/mcp/mu-shared/"))
        for p in ("/mcp/mu-shared/x", "/mcp/../", "/mcp/.../"):
            self.assertIsNone(px.MCP_PATH.match(p), p)
        kinds = {(m, k) for m, _rx, k, _t, _q in px.RULES}
        self.assertNotIn(("DELETE", "approval"), kinds)
        deletes = [(tpl) for m, _rx, _k, tpl, _q in px.RULES if m == "DELETE"]
        self.assertEqual(deletes, ["/banks/{bank}/documents/{doc}"])
        for m, rx, k, tpl, q in px.RULES:
            if m == "DELETE":
                self.assertIsNone(rx.match("/v1/default/banks/b/documents/.."))
                self.assertIsNone(rx.match("/v1/default/banks/b"))

    def test_only_the_configured_writer_may_write(self):
        """Stage D B3: with write_images set, Claude Code, Hermes and curl read only; AgenticOS writes."""
        import proxy as px

        class Fake:
            write_images = ["bun.exe"]
        chk = px.Proxy.writer_refusal
        self.assertIsNone(chk(Fake(), "bun.exe"))
        self.assertIsNone(chk(Fake(), "BUN.EXE"))
        for image in ("claude.exe", "python.exe", "curl.exe", "hermes.exe", ""):
            self.assertIn("go through AgenticOS", chk(Fake(), image) or "", image)

        class Open:
            write_images: list = []
        self.assertIsNone(chk(Open(), "claude.exe"))
        with open(HERE.parent / "hindsight.profiles.json", encoding="utf-8") as f:
            prof = json.load(f)
        self.assertEqual(prof["profiles"]["pilot"]["proxy"].get("write_images"), ["bun.exe"])
        mcp_tools = prof["defaults"]["api_env"]["HINDSIGHT_API_MCP_ENABLED_TOOLS"].split(",")
        for t in ("sync_retain", "update_memory", "invalidate_memory", "retain"):
            self.assertNotIn(t, mcp_tools)

    def test_browser_and_rebinding_requests_refused(self):
        import proxy as px
        from starlette.requests import Request

        class Fake:
            port = 8878
        chk = px.Proxy.browser_or_rebinding

        def req(headers):
            return Request({"type": "http", "method": "GET", "path": "/", "headers": [(k.lower().encode(), v.encode()) for k, v in headers]})
        self.assertIsNone(chk(Fake(), req([("Host", "127.0.0.1:8878")])))
        self.assertIsNone(chk(Fake(), req([("Host", "localhost:8878")])))
        self.assertIsNone(chk(Fake(), req([("Host", "127.0.0.1:8878"), ("Sec-Fetch-Mode", "cors")])))  # Node fetch
        for h in ([("Host", "evil.example")], [("Host", "evil.example:8878")], [("Host", "127.0.0.1")], [],
                  [("Host", "127.0.0.1:8878"), ("Origin", "http://evil.example")],
                  [("Host", "127.0.0.1:8878"), ("Origin", "null")],
                  [("Host", "127.0.0.1:8878"), ("Sec-Fetch-Site", "same-origin"), ("Sec-Fetch-Mode", "cors")]):
            self.assertIsNotNone(chk(Fake(), req(h)), h)

    def test_daily_cap_stops_long_uptime_crash_loops(self):
        b = sv.Backoff(5, 600, [5], max_attempts=100, attempts_window_s=3600, max_consecutive=5,
                       stable_uptime_s=900, max_per_day=12)
        t, restarts = 0.0, 0
        while restarts < 10000:
            t += 1000  # crashes after ~17 min each time: the consecutive count keeps resetting
            if b.next_delay(t, uptime_s=1000) is None:
                break
            restarts += 1
        self.assertEqual(restarts, 12)
        self.assertIn("24 h", b.reason)

    def test_two_mutexes_port_and_database(self):
        pilot = sv.load_profile(CONFIG, "pilot")
        synth = sv.load_profile(CONFIG, "synth")
        self.assertEqual(len(sv.mutex_names(pilot)), 2)
        self.assertNotEqual(sv.mutex_names(pilot), sv.mutex_names(synth))
        same_db = dict(synth, port=9999)
        self.assertEqual(sv.mutex_names(same_db)[1], sv.mutex_names(synth)[1])
        self.assertEqual(len(sv.mutex_names(sv.load_profile(CONFIG, "synth-hang"))), 1)

    def test_database_url_is_managed_postgres(self):
        with tempfile.TemporaryDirectory() as d:
            pw = Path(d) / "db"
            pw.write_text("synthetic-db-pw", encoding="utf-8")
            p = sv.load_profile(CONFIG, "synth")
            p = dict(p, db=dict(p["db"], password_file=str(pw)))
            self.assertEqual(sv.database_url(p), "postgresql://hindsight:synthetic-db-pw@127.0.0.1:5433/hindsight")

    def test_api_launch_scrubs_reflect(self):
        import logging
        import api_launch
        s = "[REFLECT a] forced | query='Wombat secret' | tools=[recall((query='Zephyr secret', max_tokens=9))]"
        self.assertNotIn("secret", api_launch.scrub(s))
        rec = logging.getLogRecordFactory()("hindsight_api.engine.reflect.agent", logging.INFO, "f", 1, s, (), None)
        self.assertNotIn("secret", rec.msg)
        self.assertNotIn("pw123456789", api_launch.scrub("postgresql://hindsight:pw123456789@127.0.0.1:5432/x"))


class ChainTests(unittest.TestCase):
    """Multi-provider chain: keys by reference, missing keys skipped, failover strategy set."""

    def profile(self, chain):
        p = sv.load_profile(CONFIG, "synth")
        return dict(p, llm=dict(p["llm"], chain=chain))

    def test_chain_env_and_skip(self):
        with tempfile.TemporaryDirectory() as d:
            envf = Path(d) / "a.env"
            envf.write_text('SYNTH_FILE_KEY_ZZ="from-file"\nOTHER=1\n', encoding="utf-8")
            chain = [
                {"provider": "openrouter", "model": "m/one", "api_key_ref": {"env": "SYNTH_ENV_KEY_ZZ"},
                 "extra_body": {"provider": {"zdr": True}}},
                {"provider": "groq", "model": "m/two", "api_key_ref": {"env": "SYNTH_FILE_KEY_ZZ", "file": str(envf)}},
                {"provider": "gemini", "model": "m/three", "api_key_ref": {"env": "SYNTH_MISSING_KEY_ZZ"}},
                {"provider": "openai-codex", "model": "m/four", "codex_home": "C:\\x"},
            ]
            base = {"PATH": "p", "SYNTH_ENV_KEY_ZZ": "from-env"}
            env = sv.build_api_env(self.profile(chain), FAKE_KEY, Path("D:/t"), base_env=base)
            self.assertEqual(env["HINDSIGHT_API_LLM_PROVIDER"], "openrouter")
            self.assertEqual(env["HINDSIGHT_API_LLM_API_KEY"], "from-env")
            self.assertEqual(json.loads(env["HINDSIGHT_API_LLM_EXTRA_BODY"]), {"provider": {"zdr": True}})
            self.assertEqual(env["HINDSIGHT_API_LLM_1_PROVIDER"], "groq")
            self.assertEqual(env["HINDSIGHT_API_LLM_1_API_KEY"], "from-file")
            # the gemini member has no key -> skipped; codex becomes member 2
            self.assertEqual(env["HINDSIGHT_API_LLM_2_PROVIDER"], "openai-codex")
            self.assertEqual(env["HINDSIGHT_API_LLM_2_CODEX_HOME"], "C:\\x")
            self.assertNotIn("HINDSIGHT_API_LLM_3_PROVIDER", env)
            self.assertEqual(json.loads(env["HINDSIGHT_API_LLM_STRATEGY"]), {"mode": "failover"})
            active, skipped = sv.llm_chain(self.profile(chain), base)
            self.assertEqual([m["provider"] for m in skipped], ["gemini"])

    def test_codex_home_expands_userprofile_per_machine(self):
        """The shipped profile must not name one machine's user: %USERPROFILE% is expanded from the
        supervisor's environment (an explicit env is authoritative), like api_key_ref.file."""
        raw = json.loads(CONFIG.read_text(encoding="utf-8"))
        pilot = sv.load_profile(CONFIG, "pilot")
        codex = [m for m in raw["defaults"]["llm"]["chain"] if m["provider"] == "openai-codex"][0]
        self.assertEqual(codex["codex_home"], r"%USERPROFILE%\.codex")
        self.assertNotIn("Nebula", CONFIG.read_text(encoding="utf-8"))
        base = {"PATH": "p", "OPENROUTER_API_KEY": "synthetic-or", "GROQ_API_KEY": "synthetic-groq",
                "USERPROFILE": r"C:\Users\mkhan"}
        env = sv.build_api_env(pilot, FAKE_KEY, Path("D:/t"), base_env=base)
        self.assertEqual(env["HINDSIGHT_API_LLM_2_CODEX_HOME"], r"C:\Users\mkhan\.codex")
        self.assertNotIn("%", env["HINDSIGHT_API_LLM_2_CODEX_HOME"])
        # case-insensitive name, another user, and an unset name is left as written (not silently blank)
        self.assertEqual(sv.expand_env_refs(r"%userprofile%\.codex", {"UserProfile": r"C:\Users\other"}),
                         r"C:\Users\other\.codex")
        self.assertEqual(sv.expand_env_refs(r"%NOPE_ZZ%\.codex", {}), r"%NOPE_ZZ%\.codex")
        self.assertEqual(sv.expand_env_refs(r"C:\x", {}), r"C:\x")
        # a different machine's profile expands to ITS home, with no change to the JSON
        env2 = sv.build_api_env(pilot, FAKE_KEY, Path("D:/t"), base_env=dict(base, USERPROFILE=r"C:\Users\Nebula PC"))
        self.assertEqual(env2["HINDSIGHT_API_LLM_2_CODEX_HOME"], r"C:\Users\Nebula PC\.codex")

    def test_chain_members_cannot_be_overridden_via_api_env(self):
        p = self.profile([{"provider": "openai-codex", "model": "x"}])
        for bad in ("HINDSIGHT_API_LLM_1_API_KEY", "HINDSIGHT_API_LLM_PROVIDER", "HINDSIGHT_API_LLM_STRATEGY"):
            with self.assertRaises(SystemExit):
                sv.build_api_env(dict(p, api_env={bad: "x"}), FAKE_KEY, Path("D:/t"), base_env={})

    def test_all_keys_missing_is_an_error(self):
        p = self.profile([{"provider": "groq", "api_key_ref": {"env": "SYNTH_MISSING_KEY_ZZ"}}])
        with self.assertRaises(SystemExit):
            sv.build_api_env(p, FAKE_KEY, Path("D:/t"), base_env={})


@unittest.skipUnless(sys.platform == "win32", "Windows only")
class SupervisorFileTests(unittest.TestCase):
    def make(self, d: str) -> sv.Supervisor:
        p = sv.load_profile(CONFIG, "synth")
        p = dict(p, run_dir=str(Path(d) / "run"), log_dir=str(Path(d) / "logs"))
        s = sv.Supervisor(p)
        s.key = FAKE_KEY
        return s

    def test_status_and_events_never_contain_the_key(self):
        with tempfile.TemporaryDirectory() as d:
            s = self.make(d)
            s.event("probe", note="value " + FAKE_KEY)
            s.write_status()
            blob = s.events_path.read_text(encoding="utf-8") + s.status_path.read_text(encoding="utf-8")
            self.assertNotIn(FAKE_KEY, blob)
            self.assertIn('"redacted": true', blob)

    def test_sweep_removes_stale_isolation_dirs(self):
        with tempfile.TemporaryDirectory() as d:
            s = self.make(d)
            stale = s.tmp_root / "20260101-000000" / (sv.ISOLATION_PREFIX + "abc")
            stale.mkdir(parents=True)
            (stale / "session.jsonl").write_text("synthetic", encoding="utf-8")
            s.sweep()
            self.assertEqual(list(s.tmp_root.rglob(sv.ISOLATION_PREFIX + "*")), [])

    def test_sweep_keeps_the_temp_dir_of_a_live_adoptable_api(self):
        with tempfile.TemporaryDirectory() as d:
            s = self.make(d)
            live = s.tmp_root / "20260101-live"
            stale = s.tmp_root / "20260101-stale"
            live.mkdir(parents=True)
            stale.mkdir(parents=True)
            me = os.getpid()  # stands in for a running API started by an earlier supervisor
            sv.atomic_write_json(s.api_meta_path, {"pid": me, "create_time": sv.process_create_time(me),
                                                   "launch_id": live.name})
            s.sweep()
            self.assertTrue(live.exists())
            self.assertFalse(stale.exists())

    def test_owner_temp_folders_never_block_or_get_touched(self):
        """V7: the owner's kept %TEMP%\\hindsight-claude-code-7kjduif8 must never stop the service
        and must never be read or deleted. Simulated with SYNTHETIC folders of the same name
        pattern (held open, so any attempted delete would fail loudly) in a fake %TEMP% and in
        the real %TEMP%; the real owner folder is never opened by this test."""
        real_temp = Path(tempfile.gettempdir())
        synth_real = real_temp / (sv.ISOLATION_PREFIX + "synthtest" + os.urandom(3).hex())
        with tempfile.TemporaryDirectory() as d:
            fake_temp = Path(d) / "fake-temp"
            synth_fake = fake_temp / (sv.ISOLATION_PREFIX + "7kjduif8")  # same name, synthetic copy
            for folder in (synth_fake, synth_real):
                folder.mkdir(parents=True)
                (folder / ".credentials.json").write_text('{"synthetic": true}', encoding="utf-8")
            handles = [open(synth_fake / ".credentials.json", "rb"), open(synth_real / ".credentials.json", "rb")]
            old = {k: os.environ.get(k) for k in ("TEMP", "TMP")}
            try:
                os.environ["TEMP"] = os.environ["TMP"] = str(fake_temp)
                s = self.make(d)
                s.sweep()  # must not raise
                s.sweep()
                self.assertTrue((synth_fake / ".credentials.json").exists())
                self.assertTrue((synth_real / ".credentials.json").exists())
                events = s.events_path.read_text(encoding="utf-8") if s.events_path.exists() else ""
                self.assertNotIn("isolation_leftover", events)
            finally:
                for k, v in old.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
                for h in handles:
                    h.close()
                import shutil
                shutil.rmtree(synth_real, ignore_errors=True)  # our own synthetic folder only

    def test_sweep_fails_loudly_when_a_dir_survives(self):
        with tempfile.TemporaryDirectory() as d:
            s = self.make(d)
            stale = s.tmp_root / "20260101-000000" / (sv.ISOLATION_PREFIX + "held")
            stale.mkdir(parents=True)
            held = open(stale / "locked.bin", "wb")  # Windows: an open handle blocks deletion
            try:
                with self.assertRaises(sv.LoudError):
                    s.sweep()
                self.assertIn("isolation_leftover", s.events_path.read_text(encoding="utf-8"))
            finally:
                held.close()
            s.sweep()  # once released, the next start cleans it
            self.assertEqual(list(s.tmp_root.rglob(sv.ISOLATION_PREFIX + "*")), [])


class ProviderPatchTests(unittest.TestCase):
    V1 = "\n".join([
        "    if _isolated_claude_env is None:",
        '        path = tempfile.mkdtemp(prefix="hindsight-claude-code-")',
        "        # --- M&U Ventures local patch (2026-09-25, Hindsight Phase 1 pilot) ---",
        "        import shutil",
        '        _real_credentials = r"C:\\Users\\X\\.claude\\.credentials.json"',
        "        try:",
        '            shutil.copy(_real_credentials, path + r"\\.credentials.json")',
        "        except OSError as exc:",
        "            pass",
        "        # --- end local patch ---",
        "        _isolated_claude_env = {",
    ])
    UPSTREAM = "\n".join([
        "    if _isolated_claude_env is None:",
        '        path = tempfile.mkdtemp(prefix="hindsight-claude-code-")',
        "        _isolated_claude_env = {",
    ])

    def test_v1_is_replaced_without_any_copy(self):
        out, state = patch_provider.transform(self.V1)
        self.assertEqual(state, "v1")
        self.assertEqual(patch_provider.verify(out), [])
        self.assertNotIn("shutil.copy(", out)
        self.assertIn('dir=_root', out)
        self.assertIn("raise RuntimeError(", out)  # fail closed without the isolation root
        self.assertIn("atexit.register(shutil.rmtree, path, True)", out)
        self.assertTrue(out.rstrip().endswith("_isolated_claude_env = {"))

    def test_upstream_and_idempotence(self):
        out, state = patch_provider.transform(self.UPSTREAM)
        self.assertEqual(state, "upstream")
        again, state2 = patch_provider.transform(out)
        self.assertEqual((again, state2), (out, "v3"))

    def test_v2_upgrades_to_v3(self):
        v2 = "\n".join([
            "    if _isolated_claude_env is None:",
            "        # --- M&U Ventures local patch v2 (2026-09-28): no credential copies ---",
            '        _root = os.environ.get("HINDSIGHT_CLAUDE_ISOLATION_ROOT") or None',
            '        path = tempfile.mkdtemp(prefix="hindsight-claude-code-", dir=_root)',
            "        # --- end local patch v2 ---",
            "        _isolated_claude_env = {",
        ])
        out, state = patch_provider.transform(v2)
        self.assertEqual(state, "v2")
        self.assertEqual(patch_provider.verify(out), [])
        self.assertNotIn("or None", out)

    def test_crlf_preserved(self):
        out, _ = patch_provider.transform(self.V1.replace("\n", "\r\n"))
        self.assertNotIn("\n", out.replace("\r\n", ""))

    def test_unknown_file_refused(self):
        with self.assertRaises(ValueError):
            patch_provider.transform("print('hello')\n")


if __name__ == "__main__":
    unittest.main()
