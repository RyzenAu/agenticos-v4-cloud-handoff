"""Tests for the away-mode Hermes gateway hook (REVIEW-S2 fix 3). SYNTHETIC: real loopback servers on
ephemeral ports, a temp relay.json and token file; no Hermes, no Telegram, nothing sent.

Run: python -m unittest scripts/away-mode/hermes-plugin/test_away_plugin.py (bun's audit-f4-safety test
runs it too). The installer copies only plugin.yaml and __init__.py, so this file is never installed.
"""

from __future__ import annotations

import importlib.util
import json
import socket
import tempfile
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_PLUGIN = Path(__file__).resolve().parent / "__init__.py"


def _load():
    spec = importlib.util.spec_from_file_location("away_plugin_under_test", _PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _event(text):
    source = types.SimpleNamespace(platform="telegram", user_id="123456789", chat_id="123456789", chat_type="dm")
    return types.SimpleNamespace(internal=False, source=source, text=text)


class _Server:
    """A loopback OS stand-in: mode "ok" answers like the relay, "error" answers 500, "hang" never answers."""

    def __init__(self, mode):
        self.mode = mode
        self.hits = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                outer.hits.append(body.get("text"))
                if outer.mode == "hang":
                    time.sleep(5)
                    return
                if outer.mode == "error":
                    self.send_response(500)
                    self.end_headers()
                    return
                money = "pay" in body.get("text", "").lower()
                data = json.dumps({"handled": money, "reply": "refused (synthetic OS)" if money else None}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class AwayPluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token = Path(self.tmp.name) / "relay.token"
        self.token.write_text("synthetic-token", encoding="utf-8")
        self.plugin = _load()
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.close()
        self.tmp.cleanup()

    def point_at(self, port):
        config = Path(self.tmp.name) / "relay.json"
        config.write_text(json.dumps({"url": f"http://127.0.0.1:{port}/__away/telegram", "tokenFile": str(self.token)}), encoding="utf-8")
        self.plugin._CONFIG_FILE = config

    def dispatch(self, text):
        start = time.monotonic()
        result = self.plugin.on_dispatch(event=_event(text))
        return result, time.monotonic() - start

    def test_os_up_money_is_refused_and_chat_goes_to_hermes(self):
        self.server = _Server("ok")
        self.point_at(self.server.port)
        money, _ = self.dispatch("pay the electricity bill")
        chat, took = self.dispatch("how's the receptionist going")
        self.assertEqual(money["action"], "skip")
        self.assertIsNone(chat)
        self.assertLess(took, 1.0)
        self.assertEqual(self.server.hits, ["pay the electricity bill", "how's the receptionist going"])

    def check_unreachable(self, mode):
        if mode == "down":
            self.point_at(_free_port())
        else:
            self.server = _Server(mode)
            self.point_at(self.server.port)
        money, first = self.dispatch("pay the electricity bill")
        self.assertEqual(money["action"], "skip", mode)
        self.assertLess(first, 2.6, mode)  # one short wait at most (Windows retries a refused loopback connect)
        # Remembered as down: the next messages don't wait on the OS at all.
        for text, blocked in [("transfer $200 to savings", True), ("buy 1 bitcoin", True), ("renew the domain for $30", True),
                              ("how's the receptionist going", False), ("remind me to call Mehroz at 5", False)]:
            result, took = self.dispatch(text)
            self.assertLess(took, 0.3, (mode, text))
            if blocked:
                self.assertEqual(result["action"], "skip", (mode, text))
            else:
                self.assertIsNone(result, (mode, text))
        if self.server:
            self.assertEqual(len(self.server.hits), 1, mode)

    def test_os_down(self):
        self.check_unreachable("down")

    def test_os_hung(self):
        self.check_unreachable("hang")

    def test_os_error(self):
        self.check_unreachable("error")

    def test_no_relay_set_up_fails_closed_for_money_only(self):
        self.plugin._CONFIG_FILE = Path(self.tmp.name) / "missing.json"
        self.assertEqual(self.dispatch("send $50 to Sam on PayID")[0]["action"], "skip")
        self.assertIsNone(self.dispatch("what's the weather tomorrow")[0])

    def test_down_is_retried_after_the_cache_expires(self):
        self.point_at(_free_port())
        self.dispatch("what's the weather")
        self.assertGreater(self.plugin._down_until, time.monotonic())
        self.server = _Server("ok")
        self.point_at(self.server.port)
        self.plugin._down_until = 0.0
        self.assertIsNone(self.dispatch("how's the receptionist going")[0])
        self.assertEqual(self.server.hits, ["how's the receptionist going"])

    def test_offline_word_list(self):
        words = self.plugin._MONEY_WORDS
        for text in ["pay the Telstra bill", "transfer $500 to Mehroz", "buy 10 shares of Apple", "top up OpenRouter",
                     "send 50 dollars to Sam", "place a bet on the footy", "renew the domain", "donate to the masjid",
                     "upgrade my OpenRouter plan", "issue a refund on Stripe", "log in to NetBank",
                     "send Mehroz fifty dollars", "give Sam a hundred bucks"]:
            self.assertIsNotNone(words.search(text), text)
        for text in ["how's the receptionist going", "remind me to call Mehroz at 5", "pay attention to the build",
                     "summarise my notes", "what's on today", "share the doc with Mehroz", "in order to fix the tests"]:
            self.assertIsNone(words.search(text), text)

    def test_commands_are_unchanged(self):
        seen = []
        self.plugin._relay = lambda payload, **kw: (seen.append(payload["text"]), {"handled": True, "reply": "ok"})[1]
        self.assertEqual(self.dispatch("/away on")[0]["action"], "skip")
        self.assertEqual(self.dispatch("/stop")[0]["action"], "allow")
        time.sleep(0.2)
        self.assertEqual(sorted(seen), ["/away on", "/stop"])

    def test_approval_codes_are_relayed_as_commands(self):
        """Track 6: an approval code ("approve K7PQ-M4XZ") goes the command way (the OS's approval service
        answers it, not the 1-second free-text check); a plain word never looks like a code."""
        c = self.plugin._COMMAND
        for text in ["approve K7PQ-M4XZ", "deny k7pq-m4xz", "yes K7PQ M4XZ", "approve K7PQ"]:
            self.assertIsNotNone(c.match(text), text)
        for text in ["approve payments", "approve K7PQM4XZ", "yes everyone", "approve the pending forget"]:
            self.assertIsNone(c.match(text), text)


if __name__ == "__main__":
    unittest.main()
