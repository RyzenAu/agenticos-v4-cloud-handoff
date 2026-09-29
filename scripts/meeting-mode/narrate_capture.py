"""Mic-only capture for "narrate my workflow" (scripts/meeting-mode/narrate.ts, narrate-service.ts).
SYNTHETIC TESTS ONLY exercise this directly (a played TTS clip through the default input, or the
file-input test path in narrate.test.ts); it is never run against a real walkthrough from this
repo's own tests.

This is deliberately the single-microphone half of dual_capture.py — no WASAPI loopback, because
narrating a workflow is solo speech to Jarvis, not a call with someone else's audio to separate.
Same chunking, same WAV framing, same "nothing written to disk" guarantee: each chunk's WAV bytes
go to stdout as one JSON line; narrate-service.ts sends them to the local whisper server and drops
the bytes once heard, exactly like every other path in meeting mode.

    python narrate_capture.py --probe   # is there a default microphone? Device name only — never
                                         # opens a stream. {"ok": true|false, "reason"?: "..."}
    python narrate_capture.py           # run until killed (SIGTERM from narrate-service.ts, at
                                         # "that's it"/"done" or an explicit stop); NDJSON on stdout:
                                         #   {"type": "level", "me": 0..1}                (~5 Hz)
                                         #   {"type": "chunk", "wav": "<base64 16 kHz mono 16-bit
                                         #    PCM WAV>", "cutAt": <epoch ms>}
                                         #   {"type": "error", "message": "..."}

Runs from the venv on D:\\meeting-mode, same as whisper_server.py and dual_capture.py:
    D:\\meeting-mode\\venv\\Scripts\\python.exe scripts\\meeting-mode\\narrate_capture.py
Needs the `soundcard` package, already installed for dual_capture.py.
"""

import base64
import sys
import threading
import time

import numpy as np  # noqa: F401 -- re-exported implicitly via dual_capture's type hints

# Reuses dual_capture.py's proven WAV framing and pause-based chunking verbatim — same file, same
# venv, same directory — rather than duplicating and risking the two drifting apart.
from dual_capture import RATE, BLOCK, Chunker, emit, wav_bytes


def default_mic():
    """Enumeration only — never opens a stream."""
    import soundcard as sc

    mic = sc.default_microphone()
    if mic is None:
        raise RuntimeError("no default microphone")
    return mic


def probe():
    try:
        mic = default_mic()
        emit({"ok": True, "mic": mic.name})
    except Exception as error:  # missing soundcard, no default mic, etc.
        emit({"ok": False, "reason": str(error)[:200]})


def run():
    try:
        mic = default_mic()
    except Exception as error:
        emit({"type": "error", "message": f"microphone unavailable at listening time: {error}"[:300]})
        return

    level = {"me": 0.0}
    lock = threading.Lock()
    stopping = threading.Event()

    def on_chunk(_speaker, pcm):
        emit({"type": "chunk", "wav": base64.b64encode(wav_bytes(pcm)).decode(), "cutAt": int(time.time() * 1000)})

    def capture():
        chunker = Chunker("me", on_chunk)
        try:
            with mic.recorder(samplerate=RATE, channels=1, blocksize=BLOCK) as rec:
                while not stopping.is_set():
                    block = rec.record(numframes=BLOCK)
                    mono = block[:, 0] if getattr(block, "ndim", 1) > 1 else block
                    rms = chunker.push(mono)
                    with lock:
                        level["me"] = min(1.0, rms * 8)
        except Exception as error:
            emit({"type": "error", "message": f"microphone stopped: {error}"[:300]})
        finally:
            chunker.flush()

    t = threading.Thread(target=capture, daemon=True)
    t.start()
    try:
        while t.is_alive():
            time.sleep(0.2)
            with lock:
                emit({"type": "level", "me": level["me"]})
    except KeyboardInterrupt:
        pass
    finally:
        stopping.set()


if __name__ == "__main__":
    if "--probe" in sys.argv:
        probe()
    else:
        run()
