import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleNarrateCall, narrateService } from "./narrate-service";
import { getDraft } from "./narrate-store";

const tmp = () => mkdtempSync(join(tmpdir(), "narrate-service-"));

/** A fake child_process: an EventEmitter with a writable-from-the-test `stdout` PassThrough, so
 *  narrate-service.ts's readline interface sees NDJSON lines exactly as narrate_capture.py would
 *  produce them, without spawning Python or touching any real microphone (same pattern proven in
 *  capture.test.ts for dual_capture.py). */
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

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
/** A minimum-viable WAV header (44 bytes of zero) — narrate-service.ts only checks length before
 *  handing it to whisper.transcribe(), which is faked in every test here. */
const FAKE_WAV = Buffer.alloc(44).toString("base64");

const DRAFT_JSON = JSON.stringify({
  name: "prepare-a-lead-call",
  title: "Prepare a lead call",
  summary: "Pull up the lead, check for recent info, call them, log the outcome.",
  steps: ["Open the CRM and pull up the lead", "Call them", "Log the outcome"],
  tools: ["CRM"],
  decisionPoints: [],
});

describe("narrateService — the live mic path (fake child process, no real mic)", () => {
  test("start shows the indicator and spawns the capture script; chunks accumulate; the stop phrase finishes and drafts a skill", async () => {
    const dir = tmp();
    const operatorData = join(dir, ".operator-data");
    const child = fakeChild();
    const indicators: string[] = [];
    const drafts: any[] = [];
    const heard = ["First I open the CRM and pull up the lead.", "Then I call them.", "That's it."];
    let call = 0;
    const service = narrateService(dir, {
      operatorData,
      spawner: (() => child) as any,
      whisper: { transcribe: async () => ({ text: heard[call++], ms: 5 }) },
      complete: async () => ({ choices: [{ message: { content: DRAFT_JSON } }] }),
      onIndicator: (t) => indicators.push(t),
      onDraft: (d) => drafts.push(d),
    });

    const said = service.start("how I prepare a lead call");
    expect(said).toMatch(/Recording your walkthrough on "how I prepare a lead call"/);
    expect(service.gate()).toBe("recording");

    for (let i = 0; i < heard.length; i++) {
      child.stdout.write(line({ type: "chunk", wav: FAKE_WAV, cutAt: Date.now() }));
      await tick();
    }

    expect(service.gate()).toBe("idle"); // "That's it." auto-finished the session
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe("Prepare a lead call");
    expect(drafts[0].transcript).toContain("pull up the lead");
    expect(drafts[0].transcript.endsWith("That's it.")).toBe(true);
    expect(getDraft(operatorData, drafts[0].id)?.status).toBe("draft");
    expect(indicators[0]).toMatch(/Recording your walkthrough/);
    expect(indicators.at(-1)).toMatch(/Drafting a skill/);
    expect(child.killed).toBe(true); // capture stops once the walkthrough is done
  });

  test("a chunk below the 44-byte real-WAV floor is ignored, not fed to whisper", async () => {
    const dir = tmp();
    const child = fakeChild();
    let calls = 0;
    const service = narrateService(dir, {
      operatorData: join(dir, ".operator-data"),
      spawner: (() => child) as any,
      whisper: { transcribe: async () => { calls++; return { text: "x", ms: 1 }; } },
      complete: async () => ({ choices: [{ message: { content: DRAFT_JSON } }] }),
      onIndicator: () => {},
    });
    service.start("x");
    child.stdout.write(line({ type: "chunk", wav: Buffer.from("tiny").toString("base64") })); // < 44 bytes
    await tick();
    expect(calls).toBe(0);
  });

  test("starting a second narration while one is already recording is refused", () => {
    const dir = tmp();
    const service = narrateService(dir, {
      operatorData: join(dir, ".operator-data"),
      spawner: (() => fakeChild()) as any,
      whisper: { transcribe: async () => ({ text: "", ms: 0 }) },
      complete: async () => ({ choices: [] }),
      onIndicator: () => {},
    });
    service.start("first topic");
    const second = service.start("second topic");
    expect(second).toMatch(/already recording/);
  });

  test("an explicit stop() with nothing said yet drafts nothing and says so", async () => {
    const dir = tmp();
    const child = fakeChild();
    const service = narrateService(dir, {
      operatorData: join(dir, ".operator-data"),
      spawner: (() => child) as any,
      whisper: { transcribe: async () => ({ text: "", ms: 0 }) },
      complete: async () => ({ choices: [{ message: { content: DRAFT_JSON } }] }),
      onIndicator: () => {},
    });
    service.start("x");
    const draft = await service.stop();
    expect(draft).toBeNull();
  });

  test("a bridge failure is reported, not swallowed, and the child is still stopped", async () => {
    const dir = tmp();
    const child = fakeChild();
    const errors: string[] = [];
    const service = narrateService(dir, {
      operatorData: join(dir, ".operator-data"),
      spawner: (() => child) as any,
      whisper: { transcribe: async () => ({ text: "First I do the thing.", ms: 1 }) },
      complete: async () => { throw new Error("Claude Code exited 1"); },
      onIndicator: () => {},
      onError: (m) => errors.push(m),
    });
    service.start("x");
    child.stdout.write(line({ type: "chunk", wav: FAKE_WAV, cutAt: Date.now() }));
    await tick();
    const draft = await service.stop();
    expect(draft).toBeNull();
    expect(errors.some((e) => e.includes("Claude Code exited 1"))).toBe(true);
  });
});

describe("handleNarrateCall — the free-voice.ts `narrate` tool result", () => {
  test("start returns the recording indicator line", async () => {
    const dir = tmp();
    const service = narrateService(dir, {
      operatorData: join(dir, ".operator-data"),
      spawner: (() => fakeChild()) as any,
      whisper: { transcribe: async () => ({ text: "", ms: 0 }) },
      complete: async () => ({ choices: [] }),
      onIndicator: () => {},
    });
    const said = await handleNarrateCall(service, { action: "start", topic: "how I prepare a lead call" });
    expect(said).toMatch(/Recording your walkthrough/);
  });

  test("stop with a real draft names it and says nothing was installed", async () => {
    const dir = tmp();
    const child = fakeChild();
    const service = narrateService(dir, {
      operatorData: join(dir, ".operator-data"),
      spawner: (() => child) as any,
      whisper: { transcribe: async () => ({ text: "First I do the thing. That's it.", ms: 1 }) },
      complete: async () => ({ choices: [{ message: { content: DRAFT_JSON } }] }),
      onIndicator: () => {},
    });
    await handleNarrateCall(service, { action: "start", topic: "x" });
    child.stdout.write(line({ type: "chunk", wav: FAKE_WAV, cutAt: Date.now() }));
    await tick();
    const said = await handleNarrateCall(service, { action: "stop" });
    expect(said).toMatch(/drafted a skill called "Prepare a lead call"/);
    expect(said).toMatch(/nothing was installed/);
  });
});
