// Meeting mode's speech-to-text: the local faster-whisper server (whisper_server.py) on
// 127.0.0.1:8765, run from the venv on D:\meeting-mode. Started on demand the first time meeting
// mode is armed (loading the model captures nothing), and it exits by itself after 20 idle
// minutes to free the GPU. Audio goes over loopback in the request body; nothing is written to
// disk on either side. There is deliberately no cloud fallback: if the local model can't run,
// meeting mode says so instead of quietly sending a private call to someone else's servers.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const WHISPER_URL = process.env.MEETING_WHISPER_URL || "http://127.0.0.1:8765";
export const MEETING_HOME = process.env.MEETING_MODE_HOME || "D:\\meeting-mode";

export function localTranscriber(root: string, options: { fetcher?: typeof fetch; spawner?: typeof spawn; python?: string } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const python = options.python ?? join(MEETING_HOME, "venv", "Scripts", "python.exe");
  const script = join(root, "scripts", "meeting-mode", "whisper_server.py");
  let starting: Promise<void> | null = null;

  async function health(): Promise<{ ok: boolean; loaded: boolean; model: string; device: string } | null> {
    try {
      const r = await fetcher(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async function ensure() {
    if (await health()) return;
    if (!starting) {
      starting = (async () => {
        if (!existsSync(python)) throw new Error(`The local transcriber isn't installed (${python}). See docs/MEETING-MODE.md, "Set-up".`);
        const child = (options.spawner ?? spawn)(python, [script, "--warm"], {
          detached: true, windowsHide: true, stdio: "ignore",
          env: { ...process.env, HF_HOME: join(MEETING_HOME, "hf"), MEETING_WHISPER_MODELS: join(MEETING_HOME, "models") },
        });
        child.unref();
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (await health()) return;
        }
        throw new Error("The local transcriber didn't start in 30 seconds.");
      })().finally(() => (starting = null));
    }
    await starting;
  }

  return {
    health,
    /** Start the server and load the model. Hears nothing. */
    async warm() {
      await ensure();
      const r = await fetcher(`${WHISPER_URL}/warm`, { signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`The local transcriber couldn't load its model (${r.status}).`);
      return r.json();
    },
    async transcribe(wav: Uint8Array): Promise<{ text: string; ms: number }> {
      await ensure();
      const started = Date.now();
      const r = await fetcher(`${WHISPER_URL}/transcribe`, {
        method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav as unknown as BodyInit, signal: AbortSignal.timeout(120_000),
      });
      const data = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!r.ok) throw new Error(`Local transcription failed: ${data.error ?? r.status}`);
      return { text: String(data.text ?? ""), ms: Date.now() - started };
    },
  };
}
