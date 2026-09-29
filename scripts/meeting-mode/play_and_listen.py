"""Live-test helper for meeting mode (scripts/meeting-mode/live-test.ts). SYNTHETIC CALLS ONLY.

Plays a synthetic role-play WAV out of a speaker while listening on a microphone, and streams the
microphone as raw 16 kHz mono int16 to stdout as it arrives. Nothing it hears is written to disk.
    python play_and_listen.py <synthetic.wav> <input device> <output device> [tail seconds]
"""
import sys
import threading
import wave

import numpy as np
import sounddevice as sd

path, dev_in, dev_out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
tail = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0

with wave.open(path, "rb") as w:
    rate = w.getframerate()
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

done = threading.Event()
out = sys.stdout.buffer


def on_input(indata, frames, time_info, status):
    out.write((np.clip(indata[:, 0], -1, 1) * 32767).astype(np.int16).tobytes())
    out.flush()


with sd.InputStream(samplerate=16000, channels=1, device=dev_in, dtype="float32", callback=on_input, blocksize=1600):
    sd.play(audio, samplerate=rate, device=dev_out)
    sd.wait()
    sd.sleep(int(tail * 1000))
