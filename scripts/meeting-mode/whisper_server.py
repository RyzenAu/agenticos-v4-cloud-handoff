"""Meeting mode's local transcriber (docs/MEETING-MODE.md).

A loopback-only HTTP server around faster-whisper. POST /transcribe with a 16-bit mono WAV body
returns {"text", "ms"}. The audio is decoded into a numpy array in RAM and handed straight to the
model: it is never written to disk here (no temp files, no cache, no log of what was said).

Runs from the venv on D:\\meeting-mode (C: is tight):
    D:\\meeting-mode\\venv\\Scripts\\python.exe scripts\\meeting-mode\\whisper_server.py
Env: MEETING_WHISPER_MODEL (default large-v3-turbo on the GPU, small.en on CPU),
     MEETING_WHISPER_PORT (default 8765), MEETING_WHISPER_IDLE_EXIT (seconds, default 1200).
Model weights are cached in D:\\meeting-mode\\models.
"""

import io
import json
import os
import site
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MEETING_WHISPER_PORT", "8765"))
IDLE_EXIT = int(os.environ.get("MEETING_WHISPER_IDLE_EXIT", "1200"))
MAX_BODY = 8 * 1024 * 1024
MODELS = os.environ.get("MEETING_WHISPER_MODELS", r"D:\meeting-mode\models")

# CUDA 12 / cuDNN 9 come from the nvidia-* wheels in this venv; Windows needs their bin folders.
for base in site.getsitepackages():
    for sub in ("cublas", "cudnn", "cuda_nvrtc"):
        path = os.path.join(base, "nvidia", sub, "bin")
        if os.path.isdir(path):
            os.add_dll_directory(path)
            os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402

state = {"model": None, "name": "", "device": "", "last": time.time(), "lock": threading.Lock()}


def load():
    if state["model"] is not None:
        return state["model"]
    wanted = os.environ.get("MEETING_WHISPER_MODEL", "")
    attempts = [(wanted or "large-v3-turbo", "cuda", "float16"), ((wanted or "small.en"), "cpu", "int8")]
    last_error = None
    for name, device, compute in attempts:
        try:
            model = WhisperModel(name, device=device, compute_type=compute, download_root=MODELS)
            # One silent warm-up pass so the first real chunk isn't paying for CUDA init.
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])
            state.update(model=model, name=name, device=device)
            return model
        except Exception as error:  # GPU missing/busy: fall back to CPU
            last_error = error
    raise RuntimeError(f"No whisper model could load: {last_error}")


def pcm_from_wav(body: bytes) -> "np.ndarray":
    with wave.open(io.BytesIO(body), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("16-bit WAV only")
        channels, rate = w.getnchannels(), w.getframerate()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        idx = np.arange(0, len(samples), rate / 16000.0)
        samples = np.interp(idx, np.arange(len(samples)), samples).astype(np.float32)
    return samples


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # never log requests (they'd only say "a chunk arrived" anyway)
        return

    def send(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def local(self):
        return self.client_address[0] in ("127.0.0.1", "::1") and not self.headers.get("Origin")

    def do_GET(self):
        if not self.local():
            return self.send(403, {"error": "local only"})
        if self.path == "/health":
            return self.send(200, {"ok": True, "loaded": state["model"] is not None, "model": state["name"], "device": state["device"]})
        if self.path == "/warm":
            state["last"] = time.time()
            try:
                load()
                return self.send(200, {"ok": True, "model": state["name"], "device": state["device"]})
            except Exception as error:
                return self.send(500, {"error": str(error)[:300]})
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        if not self.local():
            return self.send(403, {"error": "local only"})
        if self.path != "/transcribe":
            return self.send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 44 or length > MAX_BODY:
            return self.send(413, {"error": "bad size"})
        body = bytearray(self.rfile.read(length))
        state["last"] = time.time()
        started = time.time()
        try:
            # Half a second of silence either side: chunks are cut at pauses, and speech that starts
            # on the very first sample otherwise loses its first words to the VAD.
            audio = np.pad(pcm_from_wav(bytes(body)), (8000, 8000))
            with state["lock"]:
                model = load()
                segments, _info = model.transcribe(
                    audio, language="en", beam_size=1, vad_filter=True,
                    condition_on_previous_text=False, without_timestamps=True,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
            return self.send(200, {"text": text, "ms": int((time.time() - started) * 1000), "model": state["name"], "device": state["device"]})
        except Exception as error:
            return self.send(500, {"error": str(error)[:300]})
        finally:
            # Drop the audio from memory as soon as it's been heard.
            body[:] = b"\x00" * len(body)
            del body


def idle_watch(server):
    while True:
        time.sleep(30)
        if IDLE_EXIT and time.time() - state["last"] > IDLE_EXIT:
            server.shutdown()
            return


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=idle_watch, args=(server,), daemon=True).start()
    if "--warm" in sys.argv:
        threading.Thread(target=load, daemon=True).start()
    print(json.dumps({"listening": PORT}), flush=True)
    server.serve_forever()
