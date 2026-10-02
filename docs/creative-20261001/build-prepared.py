#!/usr/bin/env python3
"""
Free, local, vector-only motion graphics for campaign mu-creative-20261001.

Reads public/mu-creative-20261001/production-manifest.json and writes, under
public/mu-creative-20261001/assets/prepared/ :
  main-receptionist-graphics.mp4   90 s graphics track, 1920x1080, 30 fps, silent
  lead-capture-graphics.mp4        78 s graphics track, 1920x1080, 30 fps, silent
  *.srt                            caption files (timings ESTIMATED, see PRODUCTION-PREP.md)
  stills/<scene>.png               reduced-motion end-state frame per scene

No network, no paid API, no model call. Needs: python 3 + Pillow, ffmpeg on PATH.
Usage:  python docs/creative-20261001/build-prepared.py [--stills-only] [--film main|lead]
"""
import json, math, os, subprocess, sys
from multiprocessing import Pool
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CAMP = ROOT / "public" / "mu-creative-20261001"
OUT = CAMP / "assets" / "prepared"
W, H, FPS, S = 1920, 1080, 30, 2          # S = supersample factor
FONT_DIR = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
SERIF, SANS, SANSB = "georgia.ttf", "arial.ttf", "arialbd.ttf"

def hexc(h): h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
BLACK, IVORY, GOLD = hexc("#08090b"), hexc("#f4f0e7"), hexc("#c7a35a")
PANEL = hexc("#12141a")
# Agency concept palette (lead film scenes 2-6): deliberately not M&U black/gold.
A_BG, A_PAPER, A_ACC, A_PANEL = hexc("#10201b"), hexc("#f2eee4"), hexc("#7fb5a0"), hexc("#18302a")

def mix(c, bg, a): return tuple(int(bg[i] + (c[i] - bg[i]) * a) for i in range(3))
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def prog(t, a, b): return clamp((t - a) / (b - a)) if b > a else (1.0 if t >= a else 0.0)
def eo(x): return 1 - (1 - x) ** 3
def eio(x): return 3 * x * x - 2 * x * x * x

_fonts = {}
def font(name, size):
    k = (name, size)
    if k not in _fonts: _fonts[k] = ImageFont.truetype(str(FONT_DIR / name), int(size * S))
    return _fonts[k]

class Canvas:
    def __init__(self, bg):
        self.bg = bg
        self.im = Image.new("RGB", (W * S, H * S), bg)
        self.d = ImageDraw.Draw(self.im)
    def _s(self, *v): return [x * S for x in v]
    def rect(self, x0, y0, x1, y1, fill=None, outline=None, r=0, w=1):
        box = self._s(x0, y0, x1, y1)
        if r: self.d.rounded_rectangle(box, radius=r * S, fill=fill, outline=outline, width=int(w * S))
        else: self.d.rectangle(box, fill=fill, outline=outline, width=int(w * S))
    def line(self, x0, y0, x1, y1, fill, w=2):
        self.d.line(self._s(x0, y0, x1, y1), fill=fill, width=int(w * S))
    def circle(self, cx, cy, r, fill=None, outline=None, w=2):
        self.d.ellipse(self._s(cx - r, cy - r, cx + r, cy + r), fill=fill, outline=outline, width=int(w * S))
    def text(self, x, y, s, f, size, fill, anchor="l"):
        fo = font(f, size)
        width = fo.getlength(s) / S
        if anchor == "c": x -= width / 2
        elif anchor == "r": x -= width
        self.d.text((x * S, y * S), s, font=fo, fill=fill)
        return width
    def tick(self, cx, cy, size, fill, w=5):
        self.line(cx - size, cy, cx - size * 0.3, cy + size * 0.7, fill, w)
        self.line(cx - size * 0.3, cy + size * 0.7, cx + size, cy - size * 0.6, fill, w)
    def out(self): return self.im.resize((W, H), Image.LANCZOS)

# ---- shared pieces -------------------------------------------------------------------
def label(cv, t, t_in, t_out, bg, ink):
    """The single discreet 'Illustrative demonstration' label: bottom-right, 96 px margins."""
    a = min(prog(t, t_in, t_in + 0.5), 1 - prog(t, t_out - 0.1, t_out))
    if a > 0:
        cv.text(W - 96, H - 96, "Illustrative demonstration", SANS, 24, mix(ink, bg, 0.62 * a), "r")

def status_badge(cv, x, y, text, bg, ink, dot, a=1.0):
    wd = font(SANSB, 26).getlength(text) / S
    cv.rect(x, y, x + wd + 64, y + 56, fill=mix(ink, bg, 0.08 * a), outline=mix(dot, bg, 0.9 * a), r=28, w=2)
    cv.circle(x + 30, y + 28, 7, fill=mix(dot, bg, a))
    cv.text(x + 50, y + 13, text, SANSB, 26, mix(ink, bg, a))

def call_card(cv, x, y, t, tl, bg, ink, acc, panel, answered_at, w=720, h=400):
    cv.rect(x, y, x + w, y + h, fill=panel, outline=mix(ink, bg, 0.22), r=26, w=2)
    ans = t >= tl + answered_at
    cv.text(x + 48, y + 44, "CALL", SANSB, 24, mix(ink, bg, 0.5))
    status_badge(cv, x + 48, y + 100, "Answered" if ans else "Incoming call", bg, ink, acc if ans else mix(ink, bg, 0.6))
    return x, y, w, h

def wave(cv, x, y, t, acc, bg, n=18, amp=48, a=1.0):
    for i in range(n):
        hh = 8 + amp * (0.5 + 0.5 * math.sin(t * 5.0 + i * 0.7)) * (0.35 + 0.65 * math.sin(i * 0.5 + 1) ** 2)
        cv.rect(x + i * 22, y - hh / 2, x + i * 22 + 10, y + hh / 2, fill=mix(acc, bg, a), r=5)

def hline_trace(cv, x0, x1, y, p, col, w=4):
    if p > 0: cv.line(x0, y, x0 + (x1 - x0) * p, y, col, w)

def title_small(cv, x, y, s, bg, ink, a=1.0, size=58):
    cv.text(x, y, s, SERIF, size, mix(ink, bg, a))

# ---- MAIN film scenes (M&U palette) ----------------------------------------------------
def m01(cv, t, d):
    a = eo(prog(t, 1.0, 2.0))
    cv.text(96, H - 260, "Tue 10:40 am", SERIF, 48, mix(IVORY, BLACK, a))   # corner time stamp over footage

def m02(cv, t, d):
    x = 240 + (1 - eo(prog(t, 0.2, 1.0))) * 900
    a = eo(prog(t, 0.2, 0.8))
    if a > 0:
        call_card(cv, x, 340, t, 0, BLACK, IVORY, GOLD, PANEL, 3.0)
    p = eio(prog(t, 4.0, 9.0))
    hline_trace(cv, 960, 1824, 540, p, GOLD)
    if p > 0: cv.circle(960 + 864 * p, 540, 8, fill=GOLD)

def _card_and_line(cv, t, tl=99):
    call_card(cv, 240, 340, 99, 0, BLACK, IVORY, GOLD, PANEL, 0)  # state: Answered
    cv.line(960, 540, 1824, 540, mix(GOLD, BLACK, 0.55), 4)

def m03(cv, t, d):
    _card_and_line(cv, t)
    rows = [("New patient", 1.0), ("Chipped tooth", 3.8), ("Mornings", 6.6)]
    for i, (s, ts) in enumerate(rows):
        a = eo(prog(t, ts, ts + 0.7)); yy = 530 + i * 64
        if a: cv.text(288, yy, s, SERIF, 44, mix(IVORY, PANEL, a))
    ta = prog(t, 9.4, 10.0)
    if ta:
        cv.rect(1000, 500, 1560, 584, fill=mix(GOLD, BLACK, 0.12 * ta), outline=mix(GOLD, BLACK, ta), r=42, w=2)
        cv.tick(1048, 542, 16, mix(GOLD, BLACK, ta), 5)
        cv.text(1088, 520, "Practice rules applied", SANSB, 30, mix(IVORY, BLACK, ta))

def m04(cv, t, d):
    days = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    x0, y0, cw, rh = 900, 300, 170, 100
    cv.rect(x0 - 24, y0 - 24, x0 + cw * 5 + 24, y0 + rh * 4 + 108, fill=PANEL, outline=mix(IVORY, BLACK, 0.2), r=24, w=2)
    for i, dname in enumerate(days):
        cv.text(x0 + i * cw + cw / 2, y0, dname, SANSB, 28, mix(IVORY, BLACK, 0.7), "c")
        for r in range(4):
            cv.rect(x0 + i * cw + 8, y0 + 56 + r * rh, x0 + (i + 1) * cw - 8, y0 + 56 + (r + 1) * rh - 12,
                    outline=mix(IVORY, PANEL, 0.18), r=10, w=2)
    # status text (left)
    if t < 6.0:
        dots = "." * (1 + int(t * 2) % 3)
        cv.text(96, 440, "Checking calendar" + dots, SERIF, 52, IVORY)
        # scanning highlight across Thursday column slots
        sc = int(t * 3) % 4
        cv.rect(x0 + 3 * cw + 8, y0 + 56 + sc * rh, x0 + 4 * cw - 8, y0 + 56 + (sc + 1) * rh - 12, outline=mix(GOLD, PANEL, 0.6), r=10, w=3)
    else:
        f = eo(prog(t, 6.0, 6.8))
        cv.rect(x0 + 3 * cw + 8, y0 + 56, x0 + 4 * cw - 8, y0 + 56 + rh - 12, fill=mix(GOLD, PANEL, f), r=10)
        cv.text(x0 + 3 * cw + cw / 2, y0 + 56 + 28, "9:15", SANSB, 30, mix(BLACK, GOLD, f), "c")
        b = prog(t, 7.2, 7.9)
        if b: status_badge(cv, 96, 400, "Confirmed by calendar", BLACK, IVORY, GOLD, b)
        bk = eo(prog(t, 8.8, 9.6))
        if bk: cv.text(96, 500, "Booked", SERIF, 96, mix(GOLD, BLACK, bk))
        if bk: cv.text(96, 628, "Thursday, 9:15 am", SERIF, 44, mix(IVORY, BLACK, bk))

def m05(cv, t, d):
    x0, y0 = 360, 230
    cv.rect(x0, y0, x0 + 1200, y0 + 640, fill=PANEL, outline=mix(IVORY, BLACK, 0.2), r=28, w=2)
    cv.text(x0 + 56, y0 + 40, "TEAM VIEW", SANSB, 24, mix(IVORY, BLACK, 0.5))
    rows = [("Caller", "New patient", 0.8), ("Reason", "Chipped tooth", 2.2),
            ("Booking", "Thursday 9:15 am · Confirmed by calendar", 3.6)]
    for i, (k, v, ts) in enumerate(rows):
        a = eo(prog(t, ts, ts + 0.7)); yy = y0 + 110 + i * 100
        if a:
            cv.text(x0 + 56, yy + 8, k, SANSB, 26, mix(IVORY, PANEL, 0.5 * a))
            cv.text(x0 + 260, yy, v, SERIF, 40, mix(IVORY, PANEL, a))
            cv.line(x0 + 56, yy + 72, x0 + 1144, yy + 72, mix(IVORY, PANEL, 0.12 * a), 2)
    a = eo(prog(t, 5.6, 6.4))
    if a:
        cv.text(x0 + 56, y0 + 430, "SUMMARY", SANSB, 24, mix(IVORY, PANEL, 0.5 * a))
        cv.text(x0 + 56, y0 + 480, "New patient with a chipped tooth, prefers mornings.", SERIF, 38, mix(IVORY, PANEL, a))
        cv.text(x0 + 56, y0 + 540, "Booked Thursday 9:15 am after calendar confirmation.", SERIF, 38, mix(IVORY, PANEL, a))

def m06(cv, t, d):
    x0, x1, y = 160, 1760, 470
    cv.rect(x0, y, x1, y + 70, outline=mix(IVORY, BLACK, 0.25), r=8, w=2)
    for hr in (0, 6, 12, 18, 24):
        xx = x0 + (x1 - x0) * hr / 24
        cv.line(xx, y + 70, xx, y + 90, mix(IVORY, BLACK, 0.4), 2)
        cv.text(xx, y + 100, f"{hr:02d}:00", SANS, 24, mix(IVORY, BLACK, 0.6), "c")
    sx = lambda hr: x0 + (x1 - x0) * hr / 24
    names = ["All calls", "Alongside staff", "After hours", "Overflow"]
    segs = [[(0, 24)], [(8, 17)], [(0, 8), (17, 24)], [(10, 11), (13, 14), (15, 16)]]
    slot = int(clamp(t - 0.4, 0, 11.99) // 2.9)
    local = (t - 0.4) - slot * 2.9
    a = eo(prog(local, 0, 0.5)) * (1 - prog(local, 2.5, 2.9) * (slot < 3))
    for (a0, a1) in segs[slot]:
        cv.rect(sx(a0) + 2, y + 2, sx(a1) - 2, y + 68, fill=mix(GOLD, BLACK, 0.9 * clamp(a)), r=6)
    for i, nm in enumerate(names):
        xx = 160 + i * 400
        on = (i == slot) and t > 0.4
        cv.text(xx, 700, nm, SERIF, 40, mix(IVORY, BLACK, 1.0 if on else 0.35))
        cv.line(xx, 760, xx + 320, 760, mix(GOLD, BLACK, 1.0 if on else 0.15), 4 if on else 2)

def m07(cv, t, d):
    items = ["Booking tested", "Routing tested", "Texts tested"]
    for i, s in enumerate(items):
        ts = 1.0 + i * 2.5; a = eo(prog(t, ts, ts + 0.6)); yy = 270 + i * 130
        if a:
            cv.circle(190, yy + 34, 34, outline=mix(GOLD, BLACK, a), w=3)
            cv.tick(190, yy + 34, 18, mix(GOLD, BLACK, a), 6)
            cv.text(270, yy, s, SERIF, 72, mix(IVORY, BLACK, a))
    a = eo(prog(t, 9.0, 9.8))
    if a:
        cv.line(96, 740, 1824, 740, mix(IVORY, BLACK, 0.18 * a), 2)
        cv.text(96, 780, "Booking-system compatibility varies; we confirm yours during setup.", SANS, 36, mix(IVORY, BLACK, 0.85 * a))

def end_card(cv, t, d, bg, ink, acc, tagline):
    a = eo(prog(t, 0.5, 1.3))
    cv.text(120, 330, "M&U Ventures", SERIF, 110, mix(ink, bg, a))
    cv.line(124, 480, 124 + 520 * eo(prog(t, 1.0, 2.0)), 480, acc, 3)
    b = eo(prog(t, 1.8, 2.6))
    cv.text(124, 520, tagline, SANS, 40, mix(ink, bg, 0.85 * b))
    c = eo(prog(t, 3.2, 4.0))
    if c:
        wd = font(SANSB, 38).getlength("Book a 15-minute demo") / S
        cv.rect(124, 650, 124 + wd + 96, 650 + 96, fill=mix(acc, bg, c), r=48)
        cv.text(124 + 48, 650 + 24, "Book a 15-minute demo", SANSB, 38, mix(BLACK, acc, c))

def m08(cv, t, d): end_card(cv, t, d, BLACK, IVORY, GOLD, "An all-hours front desk for your business")

# ---- LEAD film scenes ------------------------------------------------------------------
def l01(cv, t, d):
    a = eo(prog(t, 1.0, 2.0))
    cv.text(96, H - 260, "Sun 7:20 pm", SERIF, 48, mix(IVORY, BLACK, a))

def l02(cv, t, d):
    bg, ink, acc, pan = A_BG, A_PAPER, A_ACC, A_PANEL
    x = 240 + (1 - eo(prog(t, 0.2, 1.0))) * 900
    if eo(prog(t, 0.2, 0.8)): call_card(cv, x, 340, t, 0, bg, ink, acc, pan, 2.5)
    a = eo(prog(t, 3.5, 4.5))
    if a: wave(cv, 1080, 540, t, acc, bg, a=a)
    if a: cv.text(1080, 610, "Listening", SANS, 28, mix(ink, bg, 0.7 * a))

def l03(cv, t, d):
    bg, ink, acc, pan = A_BG, A_PAPER, A_ACC, A_PANEL
    x0, y0 = 480, 190
    cv.rect(x0, y0, x0 + 960, y0 + 700, fill=pan, outline=mix(ink, bg, 0.22), r=28, w=2)
    cv.text(x0 + 56, y0 + 40, "ENQUIRY DETAILS", SANSB, 24, mix(ink, pan, 0.5))
    fields = [("Suburb", "[Suburb]"), ("Property type", "[Property type]"), ("Timing", "[Timing]"), ("Preferred contact", "[Preferred contact]")]
    for i, (k, v) in enumerate(fields):
        ts = 1.0 + i * 3.4; yy = y0 + 120 + i * 130
        cv.text(x0 + 56, yy, k, SANSB, 26, mix(ink, pan, 0.55))
        cv.line(x0 + 56, yy + 90, x0 + 904, yy + 90, mix(ink, pan, 0.18), 2)
        n = int(len(v) * eo(prog(t, ts, ts + 1.4)))
        if n: cv.text(x0 + 56, yy + 36, v[:n], SERIF, 40, ink)
        if t >= ts + 1.4: cv.tick(x0 + 880, yy + 50, 14, acc, 5)

def l04(cv, t, d):
    bg, ink, acc, pan = A_BG, A_PAPER, A_ACC, A_PANEL
    a = eo(prog(t, 0.6, 1.4))
    cv.rect(200, 330, 920, 650, fill=pan, outline=mix(acc, bg, a), r=28, w=3)
    cv.circle(290, 440, 36, fill=mix(acc, bg, a)); cv.tick(290, 440, 18, mix(bg, acc, 1), 6)
    cv.text(360, 410, "Request recorded", SERIF, 50, mix(ink, pan, a))
    b = eo(prog(t, 3.0, 3.8))
    cv.rect(1000, 330, 1720, 650, outline=mix(ink, bg, 0.35 * b), r=28, w=3)
    cv.circle(1090, 440, 36, outline=mix(ink, bg, 0.4 * b), w=3)
    cv.text(1160, 410, "Appointment booked", SERIF, 50, mix(ink, bg, 0.45 * b))
    c = eo(prog(t, 4.6, 5.4))
    if c: cv.text(1160, 510, "Not booked", SANSB, 36, mix(ink, bg, 0.9 * c))

def l05(cv, t, d):
    bg, ink, acc, pan = A_BG, A_PAPER, A_ACC, A_PANEL
    # team view panel on the right
    cv.rect(1100, 230, 1800, 850, fill=pan, outline=mix(ink, bg, 0.22), r=28, w=2)
    cv.text(1140, 262, "AGENCY TEAM VIEW", SANSB, 22, mix(ink, pan, 0.5))
    cv.line(220, 540, 1100, 540, mix(acc, bg, 0.5), 4)
    p = eio(prog(t, 1.5, 6.5))
    cw, ch = 520, 460
    x = 120 + (1140 - 120) * p; y = 310
    if t < 1.5:
        # collapsing form: three bars merge into the card
        k = eo(prog(t, 0.0, 1.5))
        for i in range(4):
            yy = 330 + i * 70 * (1 - 0.0) * (1 - k) + i * 22 * k
            cv.rect(120, yy, 120 + cw, yy + 56, fill=pan, outline=mix(ink, bg, 0.25), r=10, w=2)
    cv.rect(x, y, x + cw * (1 - 0.15 * p), y + ch, fill=pan, outline=mix(acc, bg, 1), r=24, w=3)
    fields = [("Caller", "[Caller]"), ("Suburb", "[Suburb]"), ("Timing", "[Timing]"), ("Asked", "[Questions asked]")]
    for i, (k, v) in enumerate(fields):
        yy = y + 36 + i * 76
        cv.text(x + 28, yy, k, SANSB, 22, mix(ink, pan, 0.5)); cv.text(x + 28, yy + 28, v, SERIF, 32, ink)
    cv.text(x + 28, y + 36 + 4 * 76 - 6, "Request recorded", SANSB, 26, acc)
    if t > 6.5:
        a = eo(prog(t, 7.2, 8.0))
        cv.text(1140, 790, "One handoff, ready for the agent", SANS, 28, mix(ink, pan, 0.8 * a))

def l06(cv, t, d):
    bg, ink, acc, pan = A_BG, A_PAPER, A_ACC, A_PANEL
    cv.line(W / 2, 260, W / 2, 820, mix(ink, bg, 0.2), 2)
    for (cx, head, s1, s2) in [(480, "Calendar connected and tested", "Confirmed by calendar", True),
                                (1440, "No calendar connected", "Request recorded", False)]:
        a = eo(prog(t, 0.4, 1.2))
        cv.text(cx, 360, head, SERIF, 44, mix(ink, bg, a), "c")
        b = eo(prog(t, 3.0, 3.8))
        if b:
            wd = font(SANSB, 34).getlength(s1) / S + 80
            cv.rect(cx - wd / 2, 480, cx + wd / 2, 560, fill=mix(ink, bg, 0.08 * b), outline=mix(acc, bg, b), r=40, w=3)
            cv.circle(cx - wd / 2 + 40, 520, 8, fill=mix(acc, bg, b))
            cv.text(cx - wd / 2 + 64, 497, s1, SANSB, 34, mix(ink, bg, b))

def l07(cv, t, d): end_card(cv, t, d, BLACK, IVORY, GOLD, "Every enquiry, a useful next step")

# ---- film definitions ------------------------------------------------------------------
FILMS = {
    "main": dict(id="main-receptionist", bg=BLACK, fn=[m01, m02, m03, m04, m05, m06, m07, m08],
                 bgs=[BLACK] * 8, label_ink=[IVORY] * 8, label_until_scene=7, out="main-receptionist-graphics"),
    "lead": dict(id="lead-capture", bg=BLACK, fn=[l01, l02, l03, l04, l05, l06, l07],
                 bgs=[BLACK, A_BG, A_BG, A_BG, A_BG, A_BG, BLACK], label_ink=[IVORY, A_PAPER, A_PAPER, A_PAPER, A_PAPER, A_PAPER, IVORY],
                 label_until_scene=6, out="lead-capture-graphics"),
}

def load_film(key):
    man = json.loads((CAMP / "production-manifest.json").read_text(encoding="utf-8"))
    film = next(f for f in man["films"] if f["id"] == FILMS[key]["id"])
    starts, acc = [], 0
    for s in film["scenes"]: starts.append(acc); acc += s["durationSeconds"]
    return film, starts, acc

def render(args):
    key, frame = args
    film, starts, total = load_film_cached(key)
    t = frame / FPS
    si = max(i for i, s in enumerate(starts) if s <= t + 1e-9)
    si = min(si, len(starts) - 1)
    return render_at(key, si, t - starts[si], t, starts, film).tobytes()

_cache = {}
def load_film_cached(key):
    if key not in _cache: _cache[key] = load_film(key)
    return _cache[key]

def render_at(key, si, local, tglobal, starts, film):
    cfg = FILMS[key]
    bg = cfg["bgs"][si]
    cv = Canvas(bg)
    dur = film["scenes"][si]["durationSeconds"]
    cfg["fn"][si](cv, local, dur)
    # persistent label: bottom-right across the demonstration scenes, gone for the end card
    end_start = starts[cfg["label_until_scene"]]
    ink = cfg["label_ink"][si]
    label(cv, tglobal, 0.3, end_start - 0.0, bg, ink)
    # fade-through-black at hard scene cuts is NOT applied: cuts are on the edit points.
    return cv.out()

def words(s): return len([w for w in s.replace("\u2014", " ").split() if w.strip()])

def srt_time(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def split_cues(text, max_words=12):
    """Split narration at sentence/clause breaks, then merge short pieces, <= max_words per cue."""
    import re
    parts = [p.strip() for p in re.split(r"(?<=[.!?:,])\s+", text) if p.strip()]
    cues = []
    for p in parts:
        if cues and not cues[-1].endswith((".", "!", "?")) and len((cues[-1] + " " + p).split()) <= max_words:
            cues[-1] += " " + p
        else:
            cues.append(p)
    out = []
    for c in cues:
        w = c.split()
        if len(w) <= max_words: out.append(c); continue
        n = math.ceil(len(w) / max_words); size = math.ceil(len(w) / n)
        out += [" ".join(w[i:i + size]) for i in range(0, len(w), size)]
    return out

def write_srt(key, wpm=150.0):
    film, starts, total = load_film(key)
    lines, n = [], 1
    for s, st in zip(film["scenes"], starts):
        dur = s["durationSeconds"]; cues = split_cues(s["narration"])
        tot_w = sum(words(c) for c in cues); speech = tot_w * 60.0 / wpm
        lead_in = 0.35                                    # estimated pause before speech
        scale = min(1.0, (dur - lead_in - 0.2) / speech)  # compress if the line would overrun the scene
        cur = st + lead_in
        for c in cues:
            span = words(c) * 60.0 / wpm * scale
            lines += [str(n), f"{srt_time(cur)} --> {srt_time(cur + span)}", c, ""]
            cur += span; n += 1
    p = OUT / f"{FILMS[key]['out'].replace('-graphics', '')}.en-AU.srt"
    p.write_text("\n".join(lines), encoding="utf-8")
    return p

def build(key, stills_only=False):
    film, starts, total = load_film(key)
    (OUT / "stills").mkdir(parents=True, exist_ok=True)
    for i, sc in enumerate(film["scenes"]):
        im = render_at(key, i, sc["durationSeconds"] - 0.05, starts[i] + sc["durationSeconds"] - 0.05, starts, film)
        im.save(OUT / "stills" / f"{sc['id']}.png", optimize=True)
    write_srt(key)
    if stills_only: return
    nframes = int(round(total * FPS))
    target = OUT / f"{FILMS[key]['out']}.mp4"
    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
                           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{total:.3f}", str(target)],
                          stdin=subprocess.PIPE)
    with Pool(max(2, (os.cpu_count() or 4) - 2)) as pool:
        for buf in pool.imap(render, [(key, f) for f in range(nframes)], chunksize=8):
            ff.stdin.write(buf)
    ff.stdin.close(); ff.wait()
    print("wrote", target, nframes, "frames")

if __name__ == "__main__":
    only = None
    if "--film" in sys.argv: only = sys.argv[sys.argv.index("--film") + 1]
    for k in ("main", "lead"):
        if only in (None, k): build(k, "--stills-only" in sys.argv)
