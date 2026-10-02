"""Rewrite main-PC absolute paths in a copied Hermes home for Ryzen-PC.

usage: py pathfix.py <hermes_home> <report.tsv> [--apply]

Rewrites only the rules in RULES. Keeps the original of every changed file as <file>.pre-ryzen
(first run only, never overwritten). Historical/log files are skipped (listed in SKIP). Anything
that still mentions the main PC afterwards is written to the report as NEEDS.
Never reads .env / auth.json.
"""
import os, re, sys

home, report = sys.argv[1], sys.argv[2]
apply_ = "--apply" in sys.argv
SEP = r"(?:\\\\|\\|/)"
SRC = "C:" + SEP + "Users" + SEP + "Nebula PC" + SEP

def seg(path):  # 'a\b\c' -> regex with any separator style
    return SEP.join(re.escape(p) for p in path.split("\\"))

# (regex of the path after 'C:\Users\Nebula PC\', replacement absolute path, what it refers to)
RULES = [
    (seg(r"AppData\Local\hermes"), r"C:\Users\mkhan\AppData\Local\hermes", "Hermes home"),
    (seg(r"AppData\Local\claude-bridge"), r"C:\Users\mkhan\AppData\Local\claude-bridge", "Claude Code bridge install (exists on Ryzen; claude.exe verified present)"),
    (seg(r".hermes"), r"C:\Users\mkhan\.hermes", "Hermes home via junction (junction created on Ryzen)"),
    (seg(r"source\repos\AgenticOS-v4\.operator-data\supervisor.log"), r"C:\mu-hub\logs\mu-hub-supervisor.log", "hub supervisor log (Ryzen supervisor LogDir, per deploy/windows/mu-hub-supervisor.ps1)"),
    (seg(r"source\repos\AgenticOS-v4\.operator-data"), r"C:\mu-hub\data\production", "hub data dir (.operator-data == MU_DATA_DIR on Ryzen)"),
    (seg(r"source\repos\AgenticOS-v4"), r"C:\mu-hub\AgenticOS-v4", "AgenticOS hub checkout"),
    (r"source" + SEP + r"repos" + SEP + r"(muv-demo-dental|muv-demo-conveyancing|aldergate|muv-marketing|muv-flagship-legal)(?![A-Za-z0-9_-])", None, "client site repo"),
]
SKIP_PARTS = ("skills/.curator_ledger.jsonl", "skills/.curator_state", "skills/.hub/", "skills/claude-skills/.agentic-os-",
              ".curator_backups", ".pre-ryzen", "/.git/")
SKIPEXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pyc", ".db", ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".mp3", ".wav", ".zip", ".gz", ".svg", ".pdf", ".docx", ".xlsx", ".pptx", ".bin", ".tar"}
NEEDS = re.compile(r"[A-Za-z]:" + SEP + r"Users" + SEP + r"Nebula PC[^\"'`<>|\r\n]*|(?<![A-Za-z0-9/:])[D-Fd-f]:[\\/]+[A-Za-z$_.%][^\"'`<>|\r\n ,;)]*|/c/Users/Nebula[^\s\"'`]*")

def style_of(m):
    if "\\\\" in m: return "esc"
    if "\\" in m: return "bs"
    return "fs"

def fmt(new, style):
    if style == "esc": return new.replace("\\", "\\\\")
    if style == "fs": return new.replace("\\", "/")
    return new

rows = []
for d, dn, fs in os.walk(home):
    dn[:] = [x for x in dn if x != ".git"]
    for f in fs:
        p = os.path.join(d, f)
        rel = os.path.relpath(p, home).replace("\\", "/")
        if f in (".env", "auth.json") or f.startswith(".env"): continue
        if os.path.splitext(f)[1].lower() in SKIPEXT: continue
        if rel.startswith("hermes-agent/") or any(s in rel or s in "/" + rel for s in SKIP_PARTS):
            continue
        if os.path.getsize(p) > 3_000_000: continue
        try:
            raw = open(p, "rb").read(); txt = raw.decode("utf-8")
        except Exception:
            continue
        if "Nebula" not in txt and not re.search(r"(?<![A-Za-z0-9/:])[D-Fd-f]:[\\/]", txt):
            continue
        lines = txt.split("\n"); changed = False
        for i, line in enumerate(lines):
            new_line = line
            for rx, rep, what in RULES:
                pat = re.compile(SRC.replace("(?:", "(?:") + "(" + rx + ")")
                def sub(m, rep=rep, what=what):
                    style = style_of(m.group(0))
                    if rep is None:
                        target = r"C:\mu-hub\repos" + "\\" + m.group(2)
                    else:
                        target = rep
                    rows.append((rel, i + 1, "REWRITTEN", m.group(0), fmt(target, style), what))
                    return fmt(target, style)
                new_line = pat.sub(sub, new_line)
            if new_line != line:
                lines[i] = new_line; changed = True
        if changed and apply_:
            bak = p + ".pre-ryzen"
            if not os.path.exists(bak):
                open(bak, "wb").write(raw)
            open(p, "wb").write("\n".join(lines).encode("utf-8"))
        # remaining references (after rewrite)
        for i, line in enumerate(lines):
            for m in NEEDS.finditer(line):
                rows.append((rel, i + 1, "NEEDS", m.group(0).strip()[:160], "", "not rewritten"))

with open(report, "w", encoding="utf-8", newline="\n") as out:
    out.write("file\tline\tstatus\told\tnew\tnote\n")
    for r in rows:
        out.write("\t".join(str(x) for x in r) + "\n")
print("rows", len(rows), "rewritten", sum(1 for r in rows if r[2] == "REWRITTEN"), "needs", sum(1 for r in rows if r[2] == "NEEDS"), "apply", apply_)
