"""Two-channel capture for meeting mode (docs/MEETING-MODE.md, "Two-channel capture"). SYNTHETIC
TESTS ONLY exercise this directly (a played tone/TTS clip); it is never pointed at a real call
from this repo's own tests.

Captures the default microphone ("me") and a WASAPI loopback of the default speaker
("prospect": whatever Zoom/Meet/Teams/a softphone is playing) as two independent streams, chunks
each on natural pauses the same way the browser's single-channel capture does
(src/lib/meeting-mode.ts), and writes one JSON line per chunk/level update to stdout. Nothing is
written to disk; capture.ts (the parent) sends each chunk's WAV bytes to the local whisper server
for transcription and drops them once heard, same as every other path in meeting mode.

    python dual_capture.py --probe   # can two-channel capture run here? Device names only —
                                      # never opens a stream. {"ok": true|false, "reason"?: "..."}
    python dual_capture.py           # run until killed (SIGTERM from capture.ts, at "stop"/"end"
                                      # or when the call is over); NDJSON on stdout:
                                      #   {"type": "mode", "mode": "two-channel"|"mixed"}
                                      #   {"type": "level", "me": 0..1, "prospect": 0..1}   (~5 Hz)
                                      #   {"type": "chunk", "speaker": "me"|"prospect",
                                      #    "wav": "<base64 16 kHz mono 16-bit PCM WAV>",
                                      #    "cutAt": <epoch ms>}
                                      #   {"type": "error", "message": "..."}

Runs from the venv on D:\\meeting-mode, same as whisper_server.py:
    D:\\meeting-mode\\venv\\Scripts\\python.exe scripts\\meeting-mode\\dual_capture.py
Needs the `soundcard` package (installed 25 Sep: uv pip install --python
D:\\meeting-mode\\venv\\Scripts\\python.exe soundcard) — pure-Python WASAPI access on Windows, no
compiler needed. Headphones are recommended: with speakers, see capture.ts's bleed guard.
"""

import base64
import io
import json
import sys
import threading
import time
import wave

import numpy as np

RATE = 16000
BLOCK = 1600  # 0.1 s at 16 kHz


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def devices():
    """Enumeration only — never opens a stream. Raises if there's no default mic/speaker, or the
    speaker has no loopback endpoint (some virtual/Bluetooth devices don't expose one)."""
    import soundcard as sc

    mic = sc.default_microphone()
    speaker = sc.default_speaker()
    if mic is None or speaker is None:
        raise RuntimeError("no default microphone or speaker")
    loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    return mic, loopback


def probe():
    try:
        mic, loopback = devices()
        emit({"ok": True, "mic": mic.name, "loopback": loopback.name})
    except Exception as error:  # missing soundcard, no devices, no loopback endpoint, etc.
        emit({"ok": False, "reason": str(error)[:200]})


def wav_bytes(pcm: "np.ndarray") -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(pcm, -1.0, 1.0) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


class Chunker:
    """Mirrors src/lib/meeting-mode.ts's cutter: long chunks at a natural pause (better accuracy),
    but a short phrase then a real pause goes at once, so a spoken command still acts within a
    couple of seconds."""

    MIN_S, MAX_S, PAUSE_S = 8, 18, 0.5

    def __init__(self, speaker: str, on_chunk):
        self.speaker = speaker
        self.on_chunk = on_chunk
        self.buf: list = []
        self.voiced = 0
        self.quiet = 0
        self.floor = 0.004

    def push(self, block: "np.ndarray") -> float:
        rms = float(np.sqrt(np.mean(np.square(block, dtype=np.float64)))) if len(block) else 0.0
        speaking = rms > max(0.012, self.floor * 3)
        if speaking:
            self.voiced += 1
            self.quiet = 0
        else:
            self.quiet += len(block)
            self.floor = self.floor * 0.98 + rms * 0.02
        self.buf.append(block)
        seconds = sum(len(b) for b in self.buf) / RATE
        if (seconds >= self.MIN_S and self.quiet >= RATE * self.PAUSE_S) or (seconds >= 1.5 and self.quiet >= RATE * 1.2) or seconds >= self.MAX_S:
            self.flush()
        return rms

    def flush(self):
        if not self.buf:
            return
        merged = np.concatenate(self.buf)
        had_speech = self.voiced * BLOCK > RATE * 0.4
        self.buf, self.voiced, self.quiet = [], 0, 0
        if had_speech:
            self.on_chunk(self.speaker, merged)


def run():
    try:
        mic, loopback = devices()
    except Exception as error:
        emit({"type": "mode", "mode": "mixed"})
        emit({"type": "error", "message": f"two-channel capture unavailable at listening time: {error}"[:300]})
        return

    emit({"type": "mode", "mode": "two-channel"})
    levels = {"me": 0.0, "prospect": 0.0}
    lock = threading.Lock()
    stopping = threading.Event()

    def on_chunk(speaker, pcm):
        emit({"type": "chunk", "speaker": speaker, "wav": base64.b64encode(wav_bytes(pcm)).decode(), "cutAt": int(time.time() * 1000)})

    def capture(recorder, key):
        chunker = Chunker(key, on_chunk)
        try:
            with recorder.recorder(samplerate=RATE, channels=1, blocksize=BLOCK) as rec:
                while not stopping.is_set():
                    block = rec.record(numframes=BLOCK)
                    mono = block[:, 0] if getattr(block, "ndim", 1) > 1 else block
                    rms = chunker.push(mono)
                    with lock:
                        levels[key] = min(1.0, rms * 8)
        except Exception as error:  # this channel failed after "two-channel" was already declared
            emit({"type": "error", "message": f"{key} channel stopped: {error}"[:300]})
        finally:
            chunker.flush()

    t_me = threading.Thread(target=capture, args=(mic, "me"), daemon=True)
    t_prospect = threading.Thread(target=capture, args=(loopback, "prospect"), daemon=True)
    t_me.start()
    t_prospect.start()
    try:
        while t_me.is_alive() or t_prospect.is_alive():
            time.sleep(0.2)
            with lock:
                emit({"type": "level", "me": levels["me"], "prospect": levels["prospect"]})
    except KeyboardInterrupt:
        pass
    finally:
        stopping.set()


if __name__ == "__main__":
    if "--probe" in sys.argv:
        probe()
    else:
        run()
