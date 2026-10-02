#!/usr/bin/env python3
"""
Assemble a finished cut from (a) the prepared graphics track, (b) the four supplied clips and
(c) optional per-scene narration files. Local ffmpeg only: no network, no paid call.

  python docs/creative-20261001/assemble-film.py --film main --footage <dir with the 4 mp4s> \
         [--narration <dir with main-01.wav ... main-08.wav>] --out <file.mp4> [--burn]

Footage rules (scene lengths come from the manifest):
  main : scene 1 = dental-hero slowed to 7 s; scene 2 = its last frame, dimmed, held 10 s (card slides over it);
         scenes 3-7 = solid #08090b; scene 8 = mu-brand-loop slowed to 10 s.
  lead : scene 1 = property-hero slowed to 8 s; scene 2 = its last frame dimmed, 11 s;
         scenes 3-6 = solid agency green #10201b; scene 7 = mu-brand-loop slowed to 9 s.
The graphics track keeps its own background colour per scene; that colour is keyed out so the
footage shows through, and the cards, text and label stay on top.
Narration: <scene-id>.wav|.mp3 is delayed to its scene start (+0.35 s lead-in) and mixed; absent = silent.
Captions: soft mov_text track from the SRT by default; --burn renders them into the picture.
Missing footage: the tool stops and names the missing file. It never invents footage.
"""
import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CAMP = ROOT / "public" / "mu-creative-20261001"
PREP = CAMP / "assets" / "prepared"
CFG = {
    "main": dict(id="main-receptionist", hero="dental-hero.mp4", scenes=(7, 10, 63, 10), solid="0x08090b",
                 keys=[("0x08090b", 0, 90)], gfx="main-receptionist-graphics.mp4", srt="main-receptionist.en-AU.srt"),
    "lead": dict(id="lead-capture", hero="property-hero.mp4", scenes=(8, 11, 50, 9), solid="0x10201b",
                 keys=[("0x08090b", 0, 8), ("0x10201b", 8, 69), ("0x08090b", 69, 78)], gfx="lead-capture-graphics.mp4", srt="lead-capture.en-AU.srt"),
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--film", choices=CFG, required=True)
    ap.add_argument("--footage", required=True)
    ap.add_argument("--narration")
    ap.add_argument("--out", required=True)
    ap.add_argument("--burn", action="store_true")
    a = ap.parse_args()
    c = CFG[a.film]
    fd = Path(a.footage)
    hero, brand = fd / c["hero"], fd / "mu-brand-loop.mp4"
    for f in (hero, brand, PREP / c["gfx"], PREP / c["srt"]):
        if not f.exists(): sys.exit(f"missing input: {f}")
    man = json.loads((CAMP / "production-manifest.json").read_text(encoding="utf-8"))
    film = next(f for f in man["films"] if f["id"] == c["id"])
    d1, d2, d3, d4 = c["scenes"]
    assert d1 + d2 + d3 + d4 == film["targetSeconds"]
    hd = lambda src: float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)]).decode())
    h_len, b_len = hd(hero), hd(brand)
    fg = [
        f"[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,setsar=1,split=2[h1][h2]",
        f"[h1]setpts={d1 / h_len:.5f}*(PTS-STARTPTS),trim=duration={d1}[s1]",
        f"[h2]trim=start={max(h_len - 0.05, 0):.3f},setpts=PTS-STARTPTS,loop=loop=-1:size=1,trim=duration={d2},colorchannelmixer=rr=0.38:gg=0.38:bb=0.38,setpts=PTS-STARTPTS[s2]",
        f"color=c={c['solid']}:s=1920x1080:r=30:d={d3}[s3]",
        f"[1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,setsar=1,setpts={d4 / b_len:.5f}*(PTS-STARTPTS),trim=duration={d4}[s4]",
        "[s1][s2][s3][s4]concat=n=4:v=1:a=0[bg]",
    ]
    n = len(c["keys"])
    fg.append(f"[2:v]format=rgba,split={n}" + "".join(f"[g{i}]" for i in range(n)))
    last = "bg"
    for i, (col, t0, t1) in enumerate(c["keys"]):
        fg.append(f"[g{i}]colorkey={col}:0.02:0.0[k{i}]")
        fg.append(f"[{last}][k{i}]overlay=enable='between(t,{t0},{t1 + 0.001})':format=auto[o{i}]")
        last = f"o{i}"
    vlabel = last
    inputs = ["-i", str(hero), "-i", str(brand), "-i", str(PREP / c["gfx"])]
    if a.burn:
        srt = str(PREP / c["srt"]).replace("\\", "/").replace(":", "\\:")
        fg.append(f"[{vlabel}]subtitles='{srt}':force_style='FontName=Arial,FontSize=12,PrimaryColour=&H00E7F0F4,OutlineColour=&H00000000,Outline=2,MarginV=44'[vout]")
        vlabel = "vout"
    amap, extra, idx = [], [], 3
    if a.narration:
        nd = Path(a.narration); start = 0; labels = []
        for s in film["scenes"]:
            f = next((p for p in (nd / f"{s['id']}.wav", nd / f"{s['id']}.mp3") if p.exists()), None)
            if f:
                inputs += ["-i", str(f)]
                ms = int((start + 0.35) * 1000)
                fg.append(f"[{idx}:a]aresample=48000,adelay={ms}|{ms}[a{idx}]"); labels.append(f"[a{idx}]"); idx += 1
            else:
                print("no narration file for", s["id"])
            start += s["durationSeconds"]
        if labels:
            fg.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad,atrim=duration={film['targetSeconds']}[aout]")
            amap = ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
    srt_idx = idx
    if not a.burn:
        inputs += ["-i", str(PREP / c["srt"])]
        extra = ["-map", f"{srt_idx}:s", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng"]
    cmd = ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(fg), "-map", f"[{vlabel}]", *amap, *extra,
           "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-t", str(film["targetSeconds"]),
           "-movflags", "+faststart", a.out]
    subprocess.check_call(cmd)
    print("wrote", a.out)

if __name__ == "__main__":
    main()
