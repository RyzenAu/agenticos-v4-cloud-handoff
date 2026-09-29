"""Tests for the Hermes lead-hunt wrapper (AUDIT-A4 #5). No network, no bun: hunt() is replaced
with synthetic nights and every state file lives in a temp folder.

    python -m unittest scripts/leads/hermes/test_lead_hunt.py
"""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lead_hunt", os.path.join(HERE, "lead-hunt.py"))
lh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lh)

def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def write_json(path, data):
    write_text(path, json.dumps(data))


TIMEOUT = "Overpass 504: Gateway Timeout (after 3 attempts: overpass-api.de)"


class Classify(unittest.TestCase):
    def test_504_is_a_timeout_not_a_rate_limit(self):
        code, problem, action = lh.classify([f"dental: {TIMEOUT}", f"real-estate: {TIMEOUT}"])
        self.assertEqual(code, "osm-timeout")
        self.assertIn("timed out", problem)
        self.assertIn("OVERPASS_URLS", action)

    def test_other_transient_answers(self):
        for text in ("Overpass 502: Bad Gateway", "Overpass 503: Service Unavailable", "Overpass timeout: no answer in 30 s",
                     "Overpass unreachable: TypeError", "TimeoutExpired"):
            self.assertEqual(lh.classify([f"dental: {text}"])[0], "osm-timeout", text)

    def test_429_is_a_rate_limit(self):
        self.assertEqual(lh.classify(["dental: Overpass 429: Too Many Requests (after 3 attempts: overpass-api.de)"])[0], "osm-rate-limit")

    def test_unknown_area_and_other_overpass_errors(self):
        self.assertEqual(lh.classify(['dental: Don\'t know where "Nowhere NSW" is (overpass)'])[0], "osm-area")
        self.assertEqual(lh.classify(["dental: Overpass 400: Bad Request"])[0], "osm-other")


class Nights(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        lh.STATE = os.path.join(self.dir, "state.json")
        self.clock = 0
        lh.LAST = os.path.join(self.dir, "last.json")
        lh.ALERT = os.path.join(self.dir, "alert.json")
        self.nights = []
        lh.hunt = lambda area: self.nights.pop(0)(area)

    def run_night(self, make):
        self.nights.append(make)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = lh.main()
        return code, out.getvalue().strip(), read_json(lh.LAST)

    def tick(self):
        """One night later each call (a monotonically increasing ran_at, like the real cron)."""
        self.clock += 1
        return f"2026-10-{self.clock:02d}T01:30:00" if self.clock <= 31 else f"2026-11-{self.clock - 31:02d}T01:30:00"

    def failed(self, area):
        return {"ran_at": self.tick(), "area": area, "runs": [], "errors": [f"dental: {TIMEOUT}", f"real-estate: {TIMEOUT}"]}

    def partial(self, area):
        return {"ran_at": self.tick(), "area": area, "errors": [f"real-estate: {TIMEOUT}"],
                "runs": [{"vertical": "dental", "found": 4, "new": 1, "budget_left": None, "stopped_for_budget": False, "no_website": [], "top": []}]}

    def good(self, area, new=2):
        return {"ran_at": self.tick(), "area": area, "errors": [],
                "runs": [{"vertical": "dental", "found": 3, "new": new, "budget_left": None, "stopped_for_budget": False, "no_website": [], "top": []}]}

    def zero_new(self, area):
        return self.good(area, new=0)

    def state(self):
        return read_json(lh.STATE)

    def test_a_failed_night_exits_non_zero_and_says_so_every_night(self):
        code, said, last = self.run_night(self.failed)
        self.assertEqual(code, 1)
        self.assertEqual(last["status"], "failed")
        self.assertEqual(last["problem_code"], "osm-timeout")
        self.assertTrue(said.startswith("⚠️ Lead hunt failed (Mount Druitt NSW): OpenStreetMap's Overpass server timed out"))
        self.assertIn("Next night: Rooty Hill NSW", said)
        code, said, _ = self.run_night(self.failed)
        self.assertEqual(code, 1)
        self.assertIn("failed again (Rooty Hill NSW), failing since 2026-10-01", said)

    # ---- T5c: the rotation moves on every night -------------------------------------------------
    def test_every_night_moves_on_whatever_happened(self):
        areas = [self.run_night(make)[2]["area"] for make in (self.failed, self.partial, self.zero_new, self.good, self.failed)]
        self.assertEqual(areas, lh.AREAS[:5])  # failed, partial, 0 new and ok all advance
        st = self.state()
        self.assertEqual(st["version"], 2)
        self.assertEqual(st["last_area"], lh.AREAS[4])
        self.assertEqual({a: st["areas"][a]["last_status"] for a in lh.AREAS[:4]},
                         {lh.AREAS[0]: "failed", lh.AREAS[1]: "partial", lh.AREAS[2]: "ok", lh.AREAS[3]: "ok"})
        self.assertEqual(st["areas"][lh.AREAS[2]]["last_new"], 0)

    def test_the_stuck_case_st_marys_three_failed_nights(self):
        # The live state that stuck on St Marys (index 2): three failed nights now cover three suburbs.
        write_json(lh.STATE, {"next": 2, "last_area": "Rooty Hill NSW"})
        areas = [self.run_night(self.failed)[2]["area"] for _ in range(3)]
        self.assertEqual(areas, ["St Marys NSW", "Blacktown NSW", "Doonside NSW"])

    def test_v1_state_migrates_to_the_next_untried_suburb(self):
        # The live state on 29 Sep: {"next": 3, "last_area": "St Marys NSW"} -> Blacktown next.
        write_json(lh.STATE, {"next": 3, "last_area": "St Marys NSW", "timeouts": {}})
        _, _, last = self.run_night(self.good)
        self.assertEqual(last["area"], "Blacktown NSW")
        self.assertEqual(last["next_area"], "Doonside NSW")

    def test_a_full_cycle_wraps_to_the_least_recently_tried(self):
        for _ in range(len(lh.AREAS)):
            self.run_night(self.zero_new)
        _, _, last = self.run_night(self.good)
        self.assertEqual(last["area"], lh.AREAS[0])  # tried longest ago
        _, _, last = self.run_night(self.good)
        self.assertEqual(last["area"], lh.AREAS[1])

    def test_a_failed_suburb_comes_back_round_not_first(self):
        self.run_night(self.failed)  # Mount Druitt fails
        for _ in range(len(lh.AREAS) - 1):
            self.run_night(self.good)
        _, _, last = self.run_night(self.good)
        self.assertEqual(last["area"], "Mount Druitt NSW")  # retried after one full cycle
        self.assertEqual(self.state()["areas"]["Mount Druitt NSW"]["failures"], 1)

    def test_an_edited_area_list_keeps_its_history(self):
        self.run_night(self.good)
        self.run_night(self.good)
        lh.AREAS.insert(0, "Brand New Suburb NSW")
        try:
            _, _, last = self.run_night(self.good)
            self.assertEqual(last["area"], "Brand New Suburb NSW")  # never tried: goes first
            _, _, last = self.run_night(self.good)
            self.assertEqual(last["area"], "St Marys NSW")  # history kept by name, not position
        finally:
            lh.AREAS.pop(0)

    def test_state_is_durable_atomic_with_a_backup_and_never_silently_resets(self):
        self.run_night(self.good)
        self.run_night(self.good)
        self.assertTrue(os.path.exists(lh.STATE + ".bak"))
        self.assertFalse(os.path.exists(lh.STATE + ".tmp"))
        # A corrupt main file falls back to the backup instead of restarting at the first suburb.
        write_text(lh.STATE, "{ not json")
        _, _, last = self.run_night(self.good)
        self.assertEqual(last["area"], "Rooty Hill NSW")  # the backup (after night 1) says Mount Druitt was tried
        self.assertEqual(self.state()["version"], 2)

    # ---- T5c review fixes --------------------------------------------------------------------
    def test_timeout_alert_describes_the_rotation_not_the_removed_skip_rule(self):
        _, said, last = self.run_night(self.failed)
        self.assertNotIn("two nights", said)
        self.assertNotIn("skips a suburb", said)
        self.assertIn("moves on to the next suburb and retries this one when its turn comes round", said)
        self.assertIn("Next night: Rooty Hill NSW (Mount Druitt NSW is retried when its turn comes round).", said)
        self.assertNotIn("two nights", last["owner_action"])
        for code, _needles, problem, action in lh.OSM_CAUSES:
            self.assertNotIn("same suburb", action, code)

    def test_a_corrupt_state_never_overwrites_the_good_backup(self):
        self.run_night(self.good)  # state: Mount Druitt tried
        self.run_night(self.good)  # .bak now holds the night-1 state (valid JSON)
        good_bak = read_json(lh.STATE + ".bak")
        write_text(lh.STATE, "{ not json")
        _, _, last = self.run_night(self.good)  # resumes from .bak
        self.assertEqual(last["area"], "Rooty Hill NSW")
        self.assertEqual(read_json(lh.STATE + ".bak"), good_bak)  # the corrupt file was NOT copied over it
        self.assertEqual(self.state()["version"], 2)  # and the main file is valid again
        # The next night backs up normally again (the main file is valid now).
        self.run_night(self.good)
        self.assertEqual(read_json(lh.STATE + ".bak")["last_area"], "Rooty Hill NSW")

    def test_both_state_files_unreadable_says_so(self):
        write_text(lh.STATE, "{ not json")
        write_text(lh.STATE + ".bak", "also not json")
        code, said, last = self.run_night(self.good)
        self.assertEqual(code, 0)
        self.assertIn("unreadable, so the rotation restarted at the first suburb", said)
        self.assertEqual(last["area"], "Mount Druitt NSW")
        self.assertIn("unreadable", last["state_warning"])
        self.assertNotIn("_restarted", self.state())
        # A fresh install (no files at all) starts quietly.
        os.remove(lh.STATE)
        os.remove(lh.STATE + ".bak")
        _, said, _ = self.run_night(self.good)
        self.assertEqual(said, "")

    def test_recovery_prints_once_and_exits_zero(self):
        self.run_night(self.failed)
        code, said, last = self.run_night(self.good)
        self.assertEqual(code, 0)
        self.assertEqual(last["status"], "ok")
        self.assertEqual(said, "✅ Lead hunt is working again: 2 new leads in Rooty Hill NSW.")
        code, said, _ = self.run_night(self.good)
        self.assertEqual((code, said), (0, ""))


if __name__ == "__main__":
    unittest.main()
