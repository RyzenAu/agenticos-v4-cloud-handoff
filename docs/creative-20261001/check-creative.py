#!/usr/bin/env python3
"""Ad hoc consistency check for public/mu-creative-20261001 (no network, no product code)."""
import json, re, sys
from pathlib import Path
C = Path(__file__).resolve().parents[2] / "public" / "mu-creative-20261001"
html = (C / "index.html").read_text(encoding="utf-8")
man = json.loads((C / "production-manifest.json").read_text(encoding="utf-8"))
emb = json.loads(re.search(r'<script type="application/json" id="manifest">(.*?)</script>', html, re.S).group(1))
bad = []
def chk(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok: bad.append(msg)
for f in man["films"]:
    e = next(x for x in emb["films"] if x["id"] == f["id"])
    chk(sum(s["durationSeconds"] for s in f["scenes"]) == f["targetSeconds"], f"{f['id']}: scene durations sum to {f['targetSeconds']}")
    chk([(s["id"], s["durationSeconds"], s["narration"], s["visual"], s["claimEvidenceStatus"]) for s in f["scenes"]] ==
        [(s["id"], s["durationSeconds"], s["narration"], s["visual"], s["claimEvidenceStatus"]) for s in e["scenes"]], f"{f['id']}: embedded scenes match manifest")
    chk(f["title"] == e["title"] and f["targetSeconds"] == e["targetSeconds"], f"{f['id']}: title/target match")
chk(man["claimEvidenceStatusKey"] == emb["claimEvidenceStatusKey"], "claim key matches")
chk([(s["id"], s["filename"], s["prompt"], s["negativeRequirements"]) for s in man["shots"]] == [(s["id"], s["filename"], s["prompt"], s.get("negativeRequirements")) for s in emb["shots"]], "shots match")
v = man["voice"]
chk(v["voiceId"] == "hIreuBly94QFepU63yel" and v["category"] == "professional" and v["model"] == "eleven_multilingual_v2", "voice entry correct")
chk(man["generationBudgetUsd"] == 25 and (man["generationSpentUsd"] is not None or "console" in man["generationSpendNote"]), "budget 25 / spend stated or honestly marked unreadable")
brief = (C / "creative-brief.md").read_text(encoding="utf-8")
chk(not re.search(r"stock voice", html + brief) or "not a stock voice" in html, "no 'stock voice' claim")
chk("synthetic client" not in (html + brief + json.dumps(man)).lower(), "no 'synthetic client'")
# links and asset paths
refs = set(re.findall(r'(?:href|src)="([^"#][^"]*)"', html)) | set(re.findall(r'data-src="([^"]+)"', html))
for r in sorted(refs):
    if r.startswith(("http", "mailto")): chk(False, f"external ref {r}"); continue
    ok = (C / r).exists()
    pending = r.startswith("assets/") and r.endswith(".mp4") and "prepared" not in r
    chk(ok or pending, f"{r} {'exists' if ok else 'missing (honest pending state expected)'}")
for a in set(re.findall(r'href="#([^"]+)"', html)):
    chk(f'id="{a}"' in html, f"anchor #{a} resolves")
sys.exit(1 if bad else 0)
