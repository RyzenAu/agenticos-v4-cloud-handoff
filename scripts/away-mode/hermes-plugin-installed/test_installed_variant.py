"""The plugin variant the installer installs (Track 6, REVIEW-T6 R2), plus S2d's narrow free-text money-ORDER
relay (lead decision 29 Sep; installed only when the owner says so). SYNTHETIC: real loopback servers on
ephemeral ports, a temp relay.json and token; no Hermes, no Telegram, nothing sent.

Run: python -m unittest test_installed_variant   (from this folder)
"""
import importlib.util
import json
import os
import socket
import tempfile
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
OWNER_CHAT = "123456789"
MEHROZ_CHAT = "8374577224"
ORDERS = [
    "settle the AGL invoice", "go ahead and order it", "stake 10 SOL", "put $500 into VAS on Stake",
    "buy the AirPods on Amazon and pay with my saved card", "buy 1 bitcoin", "place a bet",
    # S2e: the reviewer's misses (the pre-filter now relays them; the OS classifier refuses them)
    "grab the AirPods from Amazon for me", "get me 0.1 BTC", "yep, place it", "grab me the cheapest flight to Lahore and book it",
    "snag two tickets to the Coldplay gig", "book two Qantas tickets to Lahore", "sort out the Telstra bill for me",
    "upgrade my OpenRouter plan", "place the order",
]
# Lines to other people and sorting: never refused, in either mode.
NOT_ORDERS = ["Mehroz, can you buy milk on the way home?", "order the leads by score", "pay attention to the build"]
QUESTIONS = ["how do I pay a BPAY bill", "what did I spend", "remind me to pay the bill Friday", "draft an invoice for Bianca", "how much do I owe"]
PLAIN = ["how's the receptionist going", "summarise my notes from today", "what's on my calendar tomorrow"]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def event(text, chat=OWNER_CHAT):
    source = types.SimpleNamespace(platform="telegram", user_id=chat, chat_id=chat, chat_type="dm")
    return types.SimpleNamespace(internal=False, source=source, text=text)


class FakeOS:
    """A loopback stand-in for /__away/telegram: 'orders' decides what the OS calls a money order."""

    def __init__(self, mode="ok", orders=()):
        self.mode, self.orders, self.hits = mode, set(orders), []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                outer.hits.append(body.get("text"))
                if outer.mode == "hang":
                    time.sleep(3)
                    return
                if outer.mode == "error":
                    self.send_response(500)
                    self.end_headers()
                    return
                text = body.get("text", "")
                order = text in outer.orders
                data = json.dumps({"handled": order, "reply": "refused by the OS (synthetic)" if order else None}).encode()
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


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class InstalledVariant(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token = os.path.join(self.tmp.name, "relay.token")
        with open(self.token, "w", encoding="utf-8") as f:
            f.write("synthetic-token")
        self.plugin = load(os.path.join(HERE, "__init__.py"), "away_mode_installed_variant")
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.close()
        self.tmp.cleanup()

    def point_at(self, port):
        path = os.path.join(self.tmp.name, "relay.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"url": f"http://127.0.0.1:{port}/__away/telegram", "tokenFile": self.token, "people": ["Usman", "Mehroz"]}, f)
        self.plugin._CONFIG_FILE = type(self.plugin._CONFIG_FILE)(path)

    def dispatch(self, text, chat=OWNER_CHAT):
        start = time.monotonic()
        result = self.plugin.on_dispatch(event=event(text, chat), gateway=None)
        return result, time.monotonic() - start

    # --- approval codes and commands: exactly as before -------------------------------------------------------
    def test_approval_codes_are_commands(self):
        c = self.plugin._COMMAND
        for text in ["approve K7PQ-M4XZ", "deny k7pq-m4xz", "yes K7PQ M4XZ", "approve K7PQ", "/away on", "/stop", "/status"]:
            self.assertIsNotNone(c.match(text), text)
        for text in ["approve payments", "approve K7PQM4XZ", "yes everyone", "approve the pending forget", "pay the electricity bill"]:
            self.assertIsNone(c.match(text), text)

    def test_codes_are_relayed_as_before_and_never_money_checked(self):
        seen = []
        self.plugin._relay = lambda payload: (seen.append(payload["text"]), {"handled": True, "reply": "ok"})[1]
        self.plugin._ask_os = lambda payload: self.fail("a command must never be money-checked")
        self.assertEqual(self.dispatch("approve K7PQ-M4XZ")[0]["action"], "skip")
        self.assertEqual(self.dispatch("/stop")[0]["action"], "allow")
        time.sleep(0.2)
        self.assertEqual(sorted(seen), ["/stop", "approve K7PQ-M4XZ"])

    # --- free text ---------------------------------------------------------------------------------------------
    def test_orders_refused_from_both_founders_chats_when_the_os_says_so(self):
        self.server = FakeOS("ok", orders=ORDERS)
        self.point_at(self.server.port)
        for chat in (OWNER_CHAT, MEHROZ_CHAT):
            for text in ORDERS:
                result, _ = self.dispatch(text, chat)
                self.assertEqual(result and result.get("action"), "skip", (chat, text))

    def test_money_questions_go_to_hermes(self):
        self.server = FakeOS("ok", orders=ORDERS)
        self.point_at(self.server.port)
        for chat in (OWNER_CHAT, MEHROZ_CHAT):
            for text in QUESTIONS:
                self.assertIsNone(self.dispatch(text, chat)[0], (chat, text))

    def test_text_with_no_money_words_is_never_sent_anywhere(self):
        self.server = FakeOS("ok", orders=ORDERS)
        self.point_at(self.server.port)
        for text in PLAIN:
            result, took = self.dispatch(text)
            self.assertIsNone(result, text)
            self.assertLess(took, 0.05, text)
        self.assertEqual(self.server.hits, [])

    def check_os_unreachable(self, mode):
        if mode == "down":
            self.point_at(free_port())
        else:
            self.server = FakeOS(mode)
            self.point_at(self.server.port)
        first, took = self.dispatch("buy 1 bitcoin")
        self.assertEqual(first["action"], "skip", mode)
        self.assertLess(took, 2.6, mode)
        for text in ORDERS:
            result, took = self.dispatch(text)
            self.assertEqual(result and result.get("action"), "skip", (mode, text))
            self.assertLess(took, 0.3, (mode, text))  # remembered as down: no wait
        for text in QUESTIONS + PLAIN:
            self.assertIsNone(self.dispatch(text)[0], (mode, text))

    def test_os_down_fails_closed_for_orders_only(self):
        self.check_os_unreachable("down")

    def test_os_hung_fails_closed_for_orders_only(self):
        self.check_os_unreachable("hang")

    def test_os_error_fails_closed_for_orders_only(self):
        self.check_os_unreachable("error")

    def test_no_relay_set_up_fails_closed_for_orders_only(self):
        self.plugin._CONFIG_FILE = type(self.plugin._CONFIG_FILE)(os.path.join(self.tmp.name, "missing.json"))
        self.assertEqual(self.dispatch("place a bet")[0]["action"], "skip")
        self.assertIsNone(self.dispatch("what did I spend")[0])

    def test_people_and_sorting_are_never_refused(self):
        self.server = FakeOS("ok", orders=ORDERS)
        self.point_at(self.server.port)
        for text in NOT_ORDERS:
            self.assertIsNone(self.dispatch(text)[0], text)
        self.server.close()
        self.server = None
        self.plugin._down_until = 0.0
        self.point_at(free_port())
        for text in NOT_ORDERS:
            self.assertIsNone(self.dispatch(text)[0], ("os down", text))

    def test_only_real_names_exempt_a_line(self):
        """REVIEW S2e: "Quick, buy 1 bitcoin" is an order; only a line to a person in people.json is exempt."""
        self.point_at(free_port())  # OS down: the plugin's own rule decides
        for text in ["Quick, buy 1 bitcoin now", "Urgent: pay the Telstra bill", "Listen, place a bet", "Hermes, buy the AirPods"]:
            result = self.dispatch(text)[0]
            self.assertEqual(result and result.get("action"), "skip", text)
        for text in ["Mehroz, can you buy milk on the way home?", "usman: pay you back tomorrow"]:
            self.assertIsNone(self.dispatch(text)[0], text)

    def test_offline_rule(self):
        for text in ORDERS + ["pay the Telstra bill", "transfer $200 to savings", "send $50 to Sam", "sell my VAS", "renew the domain"]:
            self.assertTrue(self.plugin._MONEY_HINT.search(text) and self.plugin._offline_order(text), text)
        for text in QUESTIONS + ["what's my bank balance", "is it worth buying bitcoin", "pay attention to the build"]:
            self.assertFalse(bool(self.plugin._MONEY_HINT.search(text)) and self.plugin._offline_order(text), text)


class FakeGuard:
    """A loopback stand-in for /__away/tool-guard: blocks when the label or url looks like money."""

    def __init__(self, mode="ok"):
        self.mode, self.hits = mode, []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                outer.hits.append((self.path, body))
                if outer.mode == "error":
                    self.send_response(500)
                    self.end_headers()
                    return
                words = json.dumps(body).lower()
                allow = not any(w in words for w in ("place your order", "pay now", "coinspot", "buy now"))
                data = json.dumps({"allow": allow} if allow else {"allow": False, "message": "Not done: a money button (synthetic)."}).encode()
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


class ToolGuardHook(unittest.TestCase):
    """A fake Hermes tool-call harness: on_pre_tool_call is called exactly as Hermes' plugin manager calls it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.token = os.path.join(self.tmp.name, "relay.token")
        with open(self.token, "w", encoding="utf-8") as f:
            f.write("synthetic-token")
        self.plugin = load(os.path.join(HERE, "__init__.py"), "away_mode_installed_variant_guard")
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.close()
        self.tmp.cleanup()

    def point_at(self, port):
        path = os.path.join(self.tmp.name, "relay.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"url": f"http://127.0.0.1:{port}/__away/telegram", "tokenFile": self.token}, f)
        self.plugin._CONFIG_FILE = type(self.plugin._CONFIG_FILE)(path)

    def call(self, tool, args, label=None, page_url=None):
        self.plugin._ref_label = lambda ref, task_id: label
        self.plugin._page_url = lambda task_id: page_url
        return self.plugin.on_pre_tool_call(tool_name=tool, args=args, task_id="t1", session_id="s1", tool_call_id="c1")

    def test_registers_the_pre_tool_call_hook(self):
        seen = []
        ctx = types.SimpleNamespace(register_hook=lambda name, fn: seen.append(name))
        self.plugin.register(ctx)
        self.assertEqual(seen, ["pre_gateway_dispatch", "pre_tool_call"])

    def test_money_presses_are_blocked_and_ordinary_ones_allowed(self):
        self.server = FakeGuard()
        self.point_at(self.server.port)
        blocked = self.call("browser_click", {"ref": "@e5"}, label="Place your order")
        self.assertEqual(blocked["action"], "block")
        self.assertIn("money", blocked["message"])
        self.assertIsNone(self.call("browser_click", {"ref": "@e2"}, label="Show more"))
        self.assertEqual(self.call("browser_navigate", {"url": "https://www.coinspot.com.au/buy"})["action"], "block")
        self.assertIsNone(self.call("browser_navigate", {"url": "https://www.youtube.com/"}))
        self.assertIsNone(self.call("computer_use", {"action": "click", "element": 3}))
        # The guard is asked at the tool-guard path, next to the relay's telegram path.
        self.assertTrue(all(path == "/__away/tool-guard" for path, _ in self.server.hits))
        # The clicked label and the tool's own arguments reach the guard.
        self.assertEqual(self.server.hits[0][1]["label"], "Place your order")
        self.assertEqual(self.server.hits[0][1]["tool"], "browser_click")

    def test_the_targeted_tabs_address_reaches_the_guard(self):
        """REVIEW S2e: the OS reads the tab the tool acts on (its own session's address), not the first tab."""
        self.server = FakeGuard()
        self.point_at(self.server.port)
        self.call("browser_click", {"ref": "@e5"}, label="Continue", page_url="https://shop.example.com/checkout")
        self.call("browser_type", {"ref": "@e3", "text": "hi"}, page_url="https://docs.example.com/")
        self.call("browser_navigate", {"url": "https://www.youtube.com/"}, page_url="https://docs.example.com/")
        self.call("computer_use", {"action": "click", "element": 3}, page_url="https://docs.example.com/")
        sent = [body.get("pageUrl") for _, body in self.server.hits]
        self.assertEqual(sent, ["https://shop.example.com/checkout", "https://docs.example.com/", None, None])

    def test_reading_is_never_asked_about(self):
        self.point_at(free_port())  # nothing listening: reading must still work
        for tool, args in [("browser_snapshot", {}), ("browser_vision", {"question": "x"}), ("browser_scroll", {"direction": "down"}), ("computer_use", {"action": "capture"}), ("computer_use", {"action": "list_windows"}), ("terminal", {"command": "ls"}), ("web_search", {"query": "x"})]:
            self.assertIsNone(self.call(tool, args), tool)

    def test_os_unreachable_blocks_browser_and_screen_input_only(self):
        self.point_at(free_port())
        for tool, args in [("browser_click", {"ref": "@e1"}), ("browser_type", {"ref": "@e1", "text": "hi"}), ("browser_press", {"key": "Enter"}), ("browser_navigate", {"url": "https://example.com"}), ("computer_use", {"action": "click", "element": 1}), ("computer_use", {"action": "type", "text": "hi"})]:
            result = self.call(tool, args)
            self.assertEqual(result and result.get("action"), "block", tool)
            self.assertIn("isn't answering", result["message"])

    def test_os_error_blocks_input(self):
        self.server = FakeGuard("error")
        self.point_at(self.server.port)
        self.assertEqual(self.call("browser_click", {"ref": "@e1"}, label="Next")["action"], "block")

    def test_a_crashing_hook_still_fails_closed_for_input(self):
        self.plugin._ask_guard = lambda payload: (_ for _ in ()).throw(RuntimeError("boom"))
        self.assertEqual(self.call("browser_click", {"ref": "@e1"})["action"], "block")
        self.assertIsNone(self.call("browser_snapshot", {}))


if __name__ == "__main__":
    unittest.main()
