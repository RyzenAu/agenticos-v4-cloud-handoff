import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { dualCapture } from "./capture";
import type { MeetingMode } from "./session";

/** A fake child_process: an EventEmitter with a writable-from-the-test `stdout` PassThrough, so
 *  capture.ts's readline interface sees NDJSON lines exactly as dual_capture.py would produce
 *  them, without spawning Python or touching any real audio device. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void; killed: boolean };
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close");
  };
  return child;
}

/** A minimum-viable WAV header (44 bytes of zero) — capture.ts only checks length before handing
 *  it to whisper.transcribe(), which is faked in every test here. */
const FAKE_WAV = Buffer.alloc(44).toString("base64");
const line = (obj: unknown) => JSON.stringify(obj) + "\n";
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function fakeMeeting() {
  const chunks: Array<{ sessionId: string; speaker: string; text: string; ms: number }> = [];
  const levels: Array<{ me: number; prospect: number }> = [];
  const modes: string[] = [];
  const meeting = {
    chunk: (input: any) => {
      chunks.push(input);
      return {} as any;
    },
    setLevels: (me: number, prospect: number) => void levels.push({ me, prospect }),
    setCaptureMode: (mode: string) => void modes.push(mode),
  } as unknown as MeetingMode;
  return { meeting, chunks, levels, modes };
}

describe("dualCapture.probe", () => {
  test("resolves 'two-channel' when dual_capture.py --probe reports ok — device enumeration only", async () => {
    const calls: string[][] = [];
    const spawner = ((_python: string, args: string[]) => {
      calls.push(args);
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end(line({ ok: true, mic: "Microphone", loopback: "Speakers (loopback)" }));
        child.emit("close");
      });
      return child as any;
    }) as any;
    const { meeting } = fakeMeeting();
    const capture = dualCapture("/root", { whisper: { transcribe: async () => ({ text: "", ms: 0 }) }, meeting: () => meeting, spawner });
    expect(await capture.probe()).toBe("two-channel");
    expect(calls[0]).toContain("--probe");
  });

  test("resolves 'mixed' when the probe says not ok, throws, or never closes (timeout)", async () => {
    const { meeting } = fakeMeeting();
    const notOk = (() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end(line({ ok: false, reason: "no loopback endpoint on this speaker" }));
        child.emit("close");
      });
      return child as any;
    }) as any;
    expect(await dualCapture("/root", { whisper: { transcribe: async () => ({ text: "", ms: 0 }) }, meeting: () => meeting, spawner: notOk }).probe()).toBe("mixed");

    const throws = (() => {
      throw new Error("spawn ENOENT: no venv at D:\\meeting-mode");
    }) as any;
    expect(await dualCapture("/root", { whisper: { transcribe: async () => ({ text: "", ms: 0 }) }, meeting: () => meeting, spawner: throws }).probe()).toBe("mixed");
  });
});

describe("dualCapture.start", () => {
  test("forwards mode, level and chunk lines from the child process to the meeting", async () => {
    const { meeting, chunks, levels, modes } = fakeMeeting();
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const texts = ["hi there"];
    const whisper = { transcribe: async () => ({ text: texts.shift() ?? "", ms: 42 }) };
    const capture = dualCapture("/root", { whisper, meeting: () => meeting, spawner });
    capture.start("m-1");
    child.stdout.write(line({ type: "mode", mode: "two-channel" }));
    child.stdout.write(line({ type: "level", me: 0.4, prospect: 0.1 }));
    child.stdout.write(line({ type: "chunk", speaker: "prospect", wav: FAKE_WAV, cutAt: Date.now() }));
    await tick();
    expect(modes).toEqual(["two-channel"]);
    expect(levels).toEqual([{ me: 0.4, prospect: 0.1 }]);
    expect(chunks).toEqual([{ sessionId: "m-1", speaker: "prospect", text: "hi there", ms: 42 }]);
  });

  test("echo/bleed guard: drops a 'me' chunk that closely matches the prospect chunk just before it", async () => {
    const { meeting, chunks } = fakeMeeting();
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const texts = ["that's too expensive for us right now", "that's too expensive for us right now"];
    const whisper = { transcribe: async () => ({ text: texts.shift() ?? "", ms: 10 }) };
    const capture = dualCapture("/root", { whisper, meeting: () => meeting, spawner });
    capture.start("m-2");
    const now = Date.now();
    child.stdout.write(line({ type: "chunk", speaker: "prospect", wav: FAKE_WAV, cutAt: now }));
    await tick();
    child.stdout.write(line({ type: "chunk", speaker: "me", wav: FAKE_WAV, cutAt: now + 500 }));
    await tick();
    expect(chunks.length).toBe(1);
    expect(chunks[0].speaker).toBe("prospect");
  });

  test("keeps a 'me' chunk that says something different, even moments after a prospect chunk", async () => {
    const { meeting, chunks } = fakeMeeting();
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const texts = ["that's too expensive for us right now", "great, see you Thursday then"];
    const whisper = { transcribe: async () => ({ text: texts.shift() ?? "", ms: 10 }) };
    const capture = dualCapture("/root", { whisper, meeting: () => meeting, spawner });
    capture.start("m-3");
    const now = Date.now();
    child.stdout.write(line({ type: "chunk", speaker: "prospect", wav: FAKE_WAV, cutAt: now }));
    await tick();
    child.stdout.write(line({ type: "chunk", speaker: "me", wav: FAKE_WAV, cutAt: now + 200 }));
    await tick();
    expect(chunks.map((c) => c.speaker)).toEqual(["prospect", "me"]);
  });

  test("keeps a 'me' chunk that matches, but lands well outside the bleed window", async () => {
    const { meeting, chunks } = fakeMeeting();
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const texts = ["that's too expensive for us right now", "that's too expensive for us right now"];
    const whisper = { transcribe: async () => ({ text: texts.shift() ?? "", ms: 10 }) };
    const capture = dualCapture("/root", { whisper, meeting: () => meeting, spawner });
    capture.start("m-3b");
    const now = Date.now();
    child.stdout.write(line({ type: "chunk", speaker: "prospect", wav: FAKE_WAV, cutAt: now }));
    await tick();
    child.stdout.write(line({ type: "chunk", speaker: "me", wav: FAKE_WAV, cutAt: now + 9000 }));
    await tick();
    expect(chunks.map((c) => c.speaker)).toEqual(["prospect", "me"]);
  });

  test("a transcription failure on one channel is dropped silently, never thrown or sent on", async () => {
    const { meeting, chunks } = fakeMeeting();
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const whisper = {
      transcribe: async () => {
        throw new Error("model busy");
      },
    };
    const capture = dualCapture("/root", { whisper, meeting: () => meeting, spawner });
    capture.start("m-4");
    child.stdout.write(line({ type: "chunk", speaker: "me", wav: FAKE_WAV, cutAt: Date.now() }));
    await tick();
    expect(chunks).toEqual([]);
  });

  test("a chunk with no usable WAV bytes, or empty transcribed text, is never sent on", async () => {
    const { meeting, chunks } = fakeMeeting();
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const whisper = { transcribe: async () => ({ text: "   ", ms: 5 }) };
    const capture = dualCapture("/root", { whisper, meeting: () => meeting, spawner });
    capture.start("m-5");
    child.stdout.write(line({ type: "chunk", speaker: "me", wav: "", cutAt: Date.now() }));
    child.stdout.write(line({ type: "chunk", speaker: "me", wav: FAKE_WAV, cutAt: Date.now() }));
    await tick();
    expect(chunks).toEqual([]);
  });

  test("an unrelated or malformed line is ignored, not thrown", async () => {
    const { meeting } = fakeMeeting();
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const capture = dualCapture("/root", { whisper: { transcribe: async () => ({ text: "", ms: 0 }) }, meeting: () => meeting, spawner });
    expect(() => capture.start("m-6")).not.toThrow();
    child.stdout.write("not json at all\n");
    child.stdout.write(line({ type: "something-else" }));
    await tick();
  });

  test("stop() kills the running child; start() is a no-op while one is already running", () => {
    const { meeting } = fakeMeeting();
    const spawned: ReturnType<typeof fakeChild>[] = [];
    const spawner = (() => {
      const c = fakeChild();
      spawned.push(c);
      return c as any;
    }) as any;
    const capture = dualCapture("/root", { whisper: { transcribe: async () => ({ text: "", ms: 0 }) }, meeting: () => meeting, spawner });
    capture.start("m-7");
    capture.start("m-7"); // must not spawn a second child while one is already running
    expect(spawned.length).toBe(1);
    capture.stop();
    expect(spawned[0].killed).toBe(true);
    capture.stop(); // idempotent
  });

  test("an error event from the child is reported through onError, never thrown", async () => {
    const { meeting } = fakeMeeting();
    const messages: string[] = [];
    const spawner = (() => fakeChild() as any) as any;
    const capture = dualCapture("/root", { whisper: { transcribe: async () => ({ text: "", ms: 0 }) }, meeting: () => meeting, spawner, onError: (m) => messages.push(m) });
    capture.start("m-8");
    await tick();
    expect(messages).toEqual([]);
  });

  test("a {type: 'error'} line from dual_capture.py itself is reported through onError", async () => {
    const { meeting } = fakeMeeting();
    const messages: string[] = [];
    let child = fakeChild();
    const spawner = (() => (child = fakeChild())) as any;
    const capture = dualCapture("/root", {
      whisper: { transcribe: async () => ({ text: "", ms: 0 }) },
      meeting: () => meeting,
      spawner,
      onError: (m) => messages.push(m),
    });
    capture.start("m-9");
    child.stdout.write(line({ type: "error", message: "prospect channel stopped: device disconnected" }));
    await tick();
    expect(messages).toEqual(["prospect channel stopped: device disconnected"]);
  });
});
