// Session-level wiring for candidate #2 (MINISTRY-JEV-BUSINESS.md): the explicit cloud-cue
// opt-in, staleness discard, per-tag cooldown, and the label-only cue log. objection-jev.ts's own
// unit tests cover the classifier itself; this covers session.ts's use of it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifyResult, ObjectionChunkInput } from "./objection-jev";
import { MeetingGateError, meetingMode } from "./session";
import { meetingStore } from "./store";

/** A tiny valid 16-bit mono WAV; the transcriber is faked, only the header is checked. */
function wav() {
  const n = 8000;
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  ascii(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); ascii(36, "data"); v.setUint32(40, n * 2, true);
  return Buffer.from(out).toString("base64");
}

function setup(options: { cloudClassify?: (input: ObjectionChunkInput) => Promise<ClassifyResult | null>; speakerOf?: () => "prospect" | "founder" | "unknown" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "meeting-cloud-cues-"));
  const store = meetingStore(root);
  const heard: string[] = [];
  const meeting = meetingMode({
    store,
    transcribe: async () => ({ text: heard.shift() ?? "", ms: 10 }),
    llm: async () => ({ text: "{}", model: "fake" }),
    crm: () => null,
    now: () => new Date("2026-09-25T02:00:00Z"),
    cloudClassify: options.cloudClassify,
    speakerOf: options.speakerOf,
  });
  return { meeting, heard, store };
}

async function listening(meeting: ReturnType<typeof meetingMode>) {
  const { sessionId } = meeting.start();
  meeting.consent({ sessionId, answer: "agreed" });
  return sessionId;
}

describe("cloud cues opt-in", () => {
  test("turning it on without an explicit disclosure is refused", async () => {
    const { meeting } = setup();
    await listening(meeting);
    expect(() => meeting.setCloudCues(true)).toThrow(MeetingGateError);
    expect(meeting.status().cloudCuesOptIn).toBe(false);
  });

  test("an explicit disclosure turns it on and is logged (no transcript text)", async () => {
    const { meeting, store } = setup();
    await listening(meeting);
    const out = meeting.setCloudCues(true, { disclosed: true });
    expect(out.cloudCuesOptIn).toBe(true);
    const [record] = store.cloudCuesOptIns();
    expect(record).toMatchObject({ on: true });
    expect(JSON.stringify(record)).not.toContain("transcript");
  });

  test("off never needs a disclosure", async () => {
    const { meeting } = setup();
    await listening(meeting);
    expect(meeting.setCloudCues(false).cloudCuesOptIn).toBe(false);
  });
});

describe("cloud classification wiring", () => {
  test("never calls the classifier unless both cuesOn and the cloud opt-in are set", async () => {
    let calls = 0;
    const { meeting, heard } = setup({ cloudClassify: async () => (calls++, null) });
    await listening(meeting);
    meeting.setCloudCues(true, { disclosed: true }); // opt-in on, but cuesOn (local cards) still off
    heard.push("that's too expensive for us");
    await meeting.audio({ sessionId: meeting.status().sessionId, audio: wav() });
    expect(calls).toBe(0);
  });

  test("a suggested tag is shown, logged (label + timestamp only), and debounced on repeat", async () => {
    let calls = 0;
    const { meeting, heard, store } = setup({
      cloudClassify: async (input) => (calls++, { chunkId: input.chunkId, suggestedTags: ["price"], answers: {}, ms: 5 }),
      speakerOf: () => "prospect",
    });
    await listening(meeting);
    meeting.setCues(true);
    meeting.setCloudCues(true, { disclosed: true });
    const sessionId = meeting.status().sessionId;

    heard.push("way too pricey for a small clinic");
    await meeting.audio({ sessionId, audio: wav() });
    await new Promise((r) => setTimeout(r, 10)); // let the fire-and-forget promise settle
    expect(meeting.status().cues.some((c) => c.tag === "price")).toBe(true);
    const cueLog = store.cueLog();
    expect(cueLog.filter((c) => c.tag === "price" && c.source === "cloud")).toHaveLength(1);
    expect(cueLog.every((c) => !("text" in c))).toBe(true);

    // A second chunk within the cooldown window shouldn't log or re-cue the same tag again, even
    // though the classifier says it's still there.
    meeting.setCues(false); // clear the shown card to make a re-add detectable
    meeting.setCues(true);
    heard.push("still too expensive, honestly");
    await meeting.audio({ sessionId, audio: wav() });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
    expect(store.cueLog().filter((c) => c.tag === "price" && c.source === "cloud")).toHaveLength(1);
  });

  test("a stale result (a newer chunk already landed) is discarded, never shown late", async () => {
    let releaseFirst: (v: ClassifyResult | null) => void = () => {};
    const first = new Promise<ClassifyResult | null>((resolve) => (releaseFirst = resolve));
    let call = 0;
    const { meeting, heard } = setup({
      cloudClassify: async (input) => {
        call++;
        if (call === 1) return first;
        return { chunkId: input.chunkId, suggestedTags: ["timing"], answers: {}, ms: 5 };
      },
      speakerOf: () => "prospect",
    });
    await listening(meeting);
    meeting.setCues(true);
    meeting.setCloudCues(true, { disclosed: true });
    const sessionId = meeting.status().sessionId;

    // Neither line matches cuesFor's own regex (deliberately), so any cue shown here can only
    // have come from the cloud classifier — which is exactly what's under test.
    heard.push("that's more than we budgeted for");
    const p1 = meeting.audio({ sessionId, audio: wav() }); // classifier #1 pending
    await p1;
    heard.push("we're pretty busy this month");
    await meeting.audio({ sessionId, audio: wav() }); // classifier #2 starts and resolves first
    await new Promise((r) => setTimeout(r, 10));
    expect(meeting.status().cues.some((c) => c.tag === "timing")).toBe(true);

    // Now the slow first call finally resolves with "price" — it must be dropped as stale.
    releaseFirst({ chunkId: "stale", suggestedTags: ["price"], answers: {}, ms: 999 });
    await new Promise((r) => setTimeout(r, 10));
    expect(meeting.status().cues.some((c) => c.tag === "price")).toBe(false);
  });

  test("a null result (abstain or failure) shows nothing and never throws", async () => {
    const { meeting, heard } = setup({ cloudClassify: async () => null, speakerOf: () => "prospect" });
    await listening(meeting);
    meeting.setCues(true);
    meeting.setCloudCues(true, { disclosed: true });
    heard.push("I'm not sure this is right for us"); // doesn't match cuesFor's own regex
    const out = await meeting.audio({ sessionId: meeting.status().sessionId, audio: wav() });
    expect(out.phase).toBe("listening");
    await new Promise((r) => setTimeout(r, 10));
    expect(meeting.status().cues).toEqual([]);
  });
});
