import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activities, coachingForLead, openCrm, upsertLead } from "../leads/crm";
import { CONSENT_SCRIPT, inCallCommand, meetingIntent } from "../../src/lib/meeting-words";
import { parseCoaching, renderNotes, type Llm } from "./coach";
import { cuesFor, mergeCues } from "./cues";
import { MeetingGateError, meetingMode } from "./session";
import { fsWriter, meetingStore, type Writer } from "./store";

const MARKER = "zebra pineapple kettle";

/** A tiny valid 16-bit mono WAV (the transcriber is faked; only the header is checked). */
function wav(seconds = 0.5) {
  const n = Math.round(16000 * seconds);
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  ascii(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); ascii(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 7) * 8000), true);
  return Buffer.from(out).toString("base64");
}

const COACH_JSON = JSON.stringify({
  title: "Cold call: Smile Dental (Sarah)", who: "Sarah, practice manager, Smile Dental", business: "Smile Dental",
  needs: ["answer calls at lunch"], objections: [{ tag: "price", said: "worried about cost", handled: "anchored to missed calls" }],
  decisions: ["demo booked"], nextSteps: [{ what: "demo call", who: "usman", when: "2026-09-29" }],
  outcome: "meeting", next: "2026-09-29", crmNote: "Sarah (PM). Misses lunch calls. Price concern. Demo Mon 29th.",
  categories: { opener: 12, discovery: 20, value: 11, objection: 15, nextStep: 18, delivery: 4, bogus: 99 },
  objectionTag: "price", wentWell: ["asked about lunch-time calls"],
  fixes: [
    { issue: "pitched before asking what happens to missed calls", betterLine: "Before I say anything, what happens when the phone rings at lunch?", framework: "CLOSER: Clarify" },
    { issue: "answered price straight away", betterLine: "What makes you say that?", framework: "Objection handling" },
    { issue: "no dollar value on the problem", betterLine: "What's one new patient worth to you?", framework: "Value equation" },
  ],
  frameworks: ["Value equation: anchor to missed calls"], followUps: [{ task: "send demo invite", due: "2026-09-26", draft: "Hi Sarah, ..." }],
  recap: "Demo booked for Monday. Seventy-nine out of a hundred. Biggest fix: ask about missed calls before pitching.",
});

function setup(options: { llm?: Llm; writer?: Writer; crm?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "meeting-"));
  const writes: Array<{ file: string; text: string }> = [];
  const writer: Writer = {
    write: (file, text) => (writes.push({ file, text }), (options.writer ?? fsWriter).write(file, text)),
    append: (file, text) => (writes.push({ file, text }), (options.writer ?? fsWriter).append(file, text)),
  };
  const store = meetingStore(root, writer);
  const heard: string[] = [];
  let transcribed = 0;
  const db = options.crm === false ? null : openCrm(join(root, "crm.sqlite"));
  const lead = db
    ? upsertLead(db, {
        placeId: "p-smile", name: "Smile Dental", vertical: "dental", area: "Mount Druitt NSW", address: "", website: "", mapsUrl: "",
        rating: null, reviews: null, emails: [], emailOk: false, score: 60, pitch: "receptionist", reasons: [], googleAt: null, phone: "0296211234",
      })
    : null;
  const llmCalls: string[] = [];
  const meeting = meetingMode({
    store,
    transcribe: async () => {
      transcribed++;
      return { text: heard.shift() ?? "", ms: 120 };
    },
    llm: options.llm ?? (async (_system, prompt) => (llmCalls.push(prompt), { text: COACH_JSON, model: "fake" })),
    crm: () => db,
    now: () => new Date("2026-09-25T02:00:00Z"),
  });
  return { root, store, meeting, heard, writes, db, lead, llmCalls, count: () => transcribed };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("consent gate", () => {
  test("no capture before start, and none while consent is pending", async () => {
    const { meeting, count } = setup();
    await expect(meeting.audio({ sessionId: "m-x", audio: wav() })).rejects.toBeInstanceOf(MeetingGateError);
    const started = meeting.start({ lead: "Smile Dental" });
    expect(started.phase).toBe("consent");
    expect(started.script).toBe(CONSENT_SCRIPT);
    expect(started.say).toContain("not listening yet");
    await expect(meeting.audio({ sessionId: started.sessionId, audio: wav() })).rejects.toBeInstanceOf(MeetingGateError);
    expect(count()).toBe(0);
  });

  test("only a yes starts listening, and the consent is logged without audio", async () => {
    const { meeting, store, heard, count } = setup();
    const { sessionId } = meeting.start({ lead: "Smile Dental" });
    const agreed = meeting.consent({ sessionId, answer: "agreed", confirmation: "they agreed", channel: "voice" });
    expect(agreed.phase).toBe("listening");
    expect(agreed.say).toBe(""); // silent from here
    heard.push("Hi Sarah, it's Usman from M&U.");
    const out = await meeting.audio({ sessionId, audio: wav() });
    expect(out.phase).toBe("listening");
    expect(count()).toBe(1);
    const [record] = store.consents();
    expect(record).toMatchObject({ answer: "agreed", confirmation: "they agreed", channel: "voice", audioStored: false, lead: { name: "Smile Dental" } });
    expect(typeof record.at).toBe("string");
  });

  test("\"they said no\" captures nothing and offers the debrief instead", async () => {
    const { meeting, store, count } = setup();
    const { sessionId } = meeting.start({ lead: "Smile Dental" });
    const declined = meeting.consent({ sessionId, answer: "declined" });
    expect(declined.phase).toBe("declined");
    expect(declined.say).toMatch(/Nothing will be captured.*debrief/);
    await expect(meeting.audio({ sessionId, audio: wav() })).rejects.toBeInstanceOf(MeetingGateError);
    expect(count()).toBe(0);
    expect(store.consents()[0].answer).toBe("declined");
    // The debrief route then coaches from his own words, on the same lead.
    const debrief = await meeting.debrief({ text: "Spoke to Sarah, she said no to the note-taker; keen on the receptionist, call Monday." });
    expect(debrief.notes.source).toBe("debrief");
    expect(debrief.notes.lead?.name).toBe("Smile Dental");
  });

  test("stop ends it immediately: later audio is refused and nothing is kept", async () => {
    const { meeting, heard, root } = setup();
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push(`they mentioned ${MARKER}`);
    await meeting.audio({ sessionId, audio: wav() });
    const stopped = meeting.stop();
    expect(stopped.phase).toBe("idle");
    expect(stopped.say).toContain("Nothing from that call was kept");
    expect(meeting._state().segments).toEqual([]);
    await expect(meeting.audio({ sessionId, audio: wav() })).rejects.toBeInstanceOf(MeetingGateError);
    for (const file of filesUnder(root)) if (!file.endsWith(".sqlite") && !file.includes(".sqlite-")) expect(readFileSync(file, "utf8")).not.toContain(MARKER);
  });

  test("a spoken \"stop recording\" from either party stops capture", async () => {
    const { meeting, heard } = setup();
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push("Actually, could you stop the recording please?");
    const out = await meeting.audio({ sessionId, audio: wav() });
    expect(out.command).toBe("stop");
    expect(meeting.status().phase).toBe("idle");
  });

  test("a chunk still being transcribed when he says stop is dropped", async () => {
    let release: (v: { text: string; ms: number }) => void = () => {};
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const meeting = meetingMode({
      store: meetingStore(root), transcribe: () => new Promise((r) => (release = r)),
      llm: async () => ({ text: COACH_JSON, model: "fake" }),
    });
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    const pending = meeting.audio({ sessionId, audio: wav() });
    meeting.stop();
    release({ text: MARKER, ms: 10 });
    expect((await pending) as { dropped?: boolean }).toMatchObject({ dropped: true });
    expect(meeting._state().segments).toEqual([]);
  });

  test("an unanswered consent question expires", () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    let clock = Date.parse("2026-09-25T02:00:00Z");
    const meeting = meetingMode({
      store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), llm: async () => ({ text: "{}", model: "x" }),
      now: () => new Date(clock), consentTimeoutMs: 60_000,
    });
    meeting.start();
    clock += 61_000;
    expect(meeting.gate()).toBe("idle");
    expect(() => meeting.consent({ answer: "agreed" })).toThrow(MeetingGateError);
  });
});

describe("privacy", () => {
  test("audio is never written to disk", async () => {
    const { meeting, heard, writes, root } = setup();
    const { sessionId } = meeting.start({ lead: "Smile Dental" });
    meeting.consent({ sessionId, answer: "agreed" });
    for (let i = 0; i < 3; i++) {
      heard.push(`chunk ${i}`);
      await meeting.audio({ sessionId, audio: wav(1) });
    }
    await meeting.end();
    // Nothing written through the store looks like audio…
    for (const w of writes) {
      expect(w.text.startsWith("RIFF")).toBe(false);
      expect(w.text).not.toContain("WAVE");
      expect(w.text).not.toContain(wav(0.01).slice(0, 12));
    }
    // …and no file anywhere under the data folder is a WAV or holds base64 audio.
    for (const file of filesUnder(root)) {
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 4).toString()).not.toBe("RIFF");
      if (!file.includes(".sqlite")) expect(bytes.toString("utf8")).not.toContain("UklGR"); // base64 "RIFF"
    }
  });

  test("the local transcriber and the page never write audio either (static check)", () => {
    const server = readFileSync(join(import.meta.dir, "whisper_server.py"), "utf8");
    expect(server).not.toMatch(/tempfile|NamedTemporaryFile|\.save\(|open\([^)]*['"]w/);
    const page = readFileSync(join(import.meta.dir, "..", "..", "src", "lib", "meeting-mode.ts"), "utf8");
    expect(page).not.toMatch(/MediaRecorder|indexedDB|localStorage\.setItem\([^)]*audio|showSaveFilePicker|download=/i);
  });

  test("the raw transcript is discarded after the summary by default", async () => {
    const { meeting, heard, root, llmCalls } = setup();
    const { sessionId } = meeting.start({ lead: "Smile Dental" });
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push(`Sarah said ${MARKER} at lunch.`);
    await meeting.audio({ sessionId, audio: wav() });
    const out = await meeting.end();
    expect(llmCalls[0]).toContain(MARKER); // it was coached from…
    expect(meeting._state().segments).toEqual([]); // …then dropped from memory
    expect(out.notes!.transcriptKept).toBe(false);
    const saved = filesUnder(root).filter((f) => !f.includes(".sqlite"));
    expect(saved.some((f) => f.endsWith(".transcript.txt"))).toBe(false);
    for (const file of saved) expect(readFileSync(file, "utf8")).not.toContain(MARKER);
  });

  test("\"keep the transcript\" keeps it for that one call only", async () => {
    const { meeting, heard, root } = setup();
    let { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push(`first call ${MARKER}. Jarvis, keep the transcript.`);
    const said = await meeting.audio({ sessionId, audio: wav() });
    expect(said.command).toBe("keep_transcript");
    await meeting.end();
    const kept = filesUnder(root).filter((f) => f.endsWith(".transcript.txt"));
    expect(kept.length).toBe(1);
    expect(readFileSync(kept[0], "utf8")).toContain(MARKER);
    // The next call is back to the default.
    ({ sessionId } = meeting.start());
    expect(meeting.status().keepTranscript).toBe(false);
  });

  test("a failed summary keeps the transcript in RAM only, for a retry", async () => {
    let fail = true;
    const { meeting, heard, root } = setup({ llm: async () => { if (fail) throw new Error("bridge down"); return { text: COACH_JSON, model: "fake" }; } });
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push(MARKER);
    await meeting.audio({ sessionId, audio: wav() });
    const first = await meeting.end();
    expect(first.phase).toBe("failed");
    expect(filesUnder(root).filter((f) => !f.includes(".sqlite")).every((f) => !readFileSync(f, "utf8").includes(MARKER))).toBe(true);
    fail = false;
    const second = await meeting.end();
    expect(second.phase).toBe("done");
    expect(meeting._state().segments).toEqual([]);
  });
});

describe("CRM", () => {
  test("meeting notes log to the lead once, however often they're applied", async () => {
    const { meeting, heard, db, lead, store } = setup();
    const { sessionId } = meeting.start({ lead: "Smile Dental" });
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push("Sarah wants lunch calls answered; demo Monday.");
    await meeting.audio({ sessionId, audio: wav() });
    const out = await meeting.end();
    expect(out.notes!.crm.applied).toBe(true);
    expect(out.notes!.coaching.score).toBe(80); // bogus category dropped, rest summed
    const again = meeting.logToLead({ notesId: out.notes!.id, lead: lead!.id });
    expect(again.notes.crm.detail).toContain("nothing duplicated");
    meeting.logToLead({ notesId: out.notes!.id, lead: "Smile Dental" });
    const acts = activities(db!, lead!.id).filter((a) => a.note.startsWith("[meeting mode]"));
    expect(acts.length).toBe(1);
    expect(acts[0].outcome).toBe("meeting");
    expect(coachingForLead(db!, lead!.id).length).toBe(1);
    expect(store.notes(out.notes!.id)!.crm.applied).toBe(true);
  });

  test("a replayed debrief is idempotent too", async () => {
    const { meeting, db, lead } = setup();
    const text = "Called Smile Dental, spoke to Sarah, demo Monday, worried about price.";
    await meeting.debrief({ text, lead: "Smile Dental" });
    await meeting.debrief({ text, lead: "Smile Dental" });
    expect(activities(db!, lead!.id).filter((a) => a.note.startsWith("[debrief]")).length).toBe(1);
    expect(coachingForLead(db!, lead!.id).length).toBe(1);
  });

  test("the Granola route gets the same coaching and CRM update", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const db = openCrm(join(root, "crm.sqlite"));
    const lead = upsertLead(db, {
      placeId: "p-smile", name: "Smile Dental", vertical: "dental", area: "", address: "", website: "", mapsUrl: "",
      rating: null, reviews: null, emails: [], emailOk: false, score: 60, pitch: "receptionist", reasons: [], googleAt: null, phone: "",
    });
    const prompts: string[] = [];
    const meeting = meetingMode({
      store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), crm: () => db,
      llm: async (system, prompt) => (prompts.push(system + prompt), { text: COACH_JSON, model: "fake" }),
      recentGranola: async () => ({ documents: [{ id: "7b1c2d3e-0000-4000-8000-000000000001", title: "Smile Dental demo", text: "Sarah wants lunch cover." }] }),
    });
    const first = await meeting.granola({});
    await meeting.granola({ query: "smile" });
    expect(first.notes.source).toBe("granola");
    expect(prompts[0]).toContain("Granola");
    expect(prompts[0]).toContain("100-point");
    expect(activities(db, lead.id).filter((a) => a.note.startsWith("[Granola]")).length).toBe(1);
    expect(activities(db, lead.id)[0].kind).toBe("meeting");
  });

  test("unmatched notes are saved but not logged until he picks the lead", async () => {
    const { meeting, heard, db } = setup({ llm: async () => ({ text: COACH_JSON.replace(/Smile Dental/g, "Nowhere Dental"), model: "fake" }) });
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push("hello");
    await meeting.audio({ sessionId, audio: wav() });
    const out = await meeting.end();
    expect(out.notes!.crm.applied).toBe(false);
    expect(out.notes!.crm.detail).toContain("Pick the lead");
    expect(db!.query("SELECT COUNT(*) AS n FROM activities").get()).toEqual({ n: 0 });
  });
});

describe("words", () => {
  test("the owner's phrases", () => {
    expect(meetingIntent("Jarvis, meeting mode for Smile Dental")).toEqual({ action: "start", lead: "Smile Dental" });
    expect(meetingIntent("meeting mode")).toEqual({ action: "start" });
    expect(meetingIntent("start meeting mode for lead 12")).toEqual({ action: "start", lead: "12" });
    expect(meetingIntent("they agreed", "consent")).toEqual({ action: "agreed" });
    expect(meetingIntent("she's happy with that", "consent")).toEqual({ action: "agreed" });
    expect(meetingIntent("I think so", "consent")).toBeNull(); // unclear → ask again, never assume
    expect(meetingIntent("they said no", "consent")).toEqual({ action: "declined" });
    expect(meetingIntent("they agreed", "idle")).toBeNull(); // no open question, no consent
    expect(meetingIntent("Jarvis, end meeting", "listening")).toEqual({ action: "end" });
    expect(meetingIntent("stop", "listening")).toEqual({ action: "stop" });
    expect(meetingIntent("end call mode")).toBeNull(); // the calling-block protocol
    expect(meetingIntent("end the call", "idle")).toBeNull();
    expect(meetingIntent("end the call", "listening")).toEqual({ action: "end" });
    expect(meetingIntent("stop", "idle")).toBeNull();
    expect(meetingIntent("Jarvis, coach my last Granola meeting")).toEqual({ action: "granola" });
    expect(meetingIntent("coach the granola call with Smile Dental")).toEqual({ action: "granola", text: "Smile Dental" });
    expect(meetingIntent("debrief for Smile Dental: spoke to Sarah, keen, call Monday")).toEqual({ action: "debrief", lead: "Smile Dental", text: "spoke to Sarah, keen, call Monday" });
    expect(meetingIntent("cue cards on")).toEqual({ action: "cues_on" });
    expect(meetingIntent("keep the transcript")).toEqual({ action: "keep_transcript" });
    for (const other of ["what's my next meeting", "book a meeting with Sarah", "what's the weather", "stop the music"]) expect(meetingIntent(other)).toBeNull();
  });

  test("in-call commands need his name, except withdrawing consent", () => {
    expect(inCallCommand("Okay thanks Sarah. Jarvis, end meeting.")).toBe("end");
    expect(inCallCommand("Jarvis stop")).toBe("stop");
    expect(inCallCommand("we need to stop wasting leads")).toBeNull();
    expect(inCallCommand("can you stop the recording")).toBe("stop");
    expect(inCallCommand("I don't want to be recorded")).toBe("stop");
    expect(inCallCommand("let's end the meeting there")).toBeNull();
  });
});

describe("coaching", () => {
  test("parse clamps scores, drops unknowns and caps fixes at three", () => {
    const parsed = parseCoaching(`Sure! ${JSON.stringify({ categories: { opener: 40, discovery: -3, bogus: 5 }, fixes: [1, 2, 3, 4].map((i) => ({ issue: `f${i}`, betterLine: "x" })), outcome: "maybe" })}`);
    expect(parsed.categories).toEqual({ opener: 15, discovery: 0 });
    expect(parsed.fixes.length).toBe(3);
    expect(parsed.outcome).toBe("");
  });

  test("cue cards: one per tag, newest first, at most three", () => {
    const fresh = cuesFor("honestly it sounds too expensive and we already have a receptionist, just send me some info");
    expect(fresh.map((c) => c.tag)).toEqual(["price", "incumbent", "send_info"]);
    const merged = mergeCues(fresh, cuesFor("I'll have a think about it"));
    expect(merged[0].tag).toBe("think_about_it");
    expect(merged.length).toBe(3);
  });

  test("cue cards stay off unless switched on", async () => {
    const { meeting, heard } = setup();
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push("that's too expensive for us");
    expect((await meeting.audio({ sessionId, audio: wav() })).cues).toEqual([]);
    meeting.setCues(true);
    heard.push("that's too expensive for us");
    expect((await meeting.audio({ sessionId, audio: wav() })).cues[0].tag).toBe("price");
  });

  test("rendered notes carry the scorecard and fixes but never a transcript", async () => {
    const { meeting, heard } = setup();
    const { sessionId } = meeting.start({ lead: "Smile Dental" });
    meeting.consent({ sessionId, answer: "agreed" });
    heard.push(MARKER);
    await meeting.audio({ sessionId, audio: wav() });
    const out = await meeting.end();
    const md = renderNotes(out.notes!);
    expect(md).toContain("| Discovery | 20/25 |");
    expect(md).toContain('Say instead: "What\'s one new patient worth to you?"');
    expect(md).toContain("nothing sent");
    expect(md).not.toContain(MARKER);
  });
});

describe("two-channel capture", () => {
  test("chunk() is gated exactly like audio(): only while listening, for this session", () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const meeting = meetingMode({ store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), llm: async () => ({ text: COACH_JSON, model: "fake" }) });
    expect(() => meeting.chunk({ sessionId: "m-x", speaker: "me", text: "hi" })).toThrow(MeetingGateError);
    const { sessionId } = meeting.start();
    expect(() => meeting.chunk({ sessionId, speaker: "me", text: "hi" })).toThrow(MeetingGateError); // consent pending, not listening yet
    meeting.consent({ sessionId, answer: "agreed" });
    expect(() => meeting.chunk({ sessionId: "wrong-session", speaker: "me", text: "hi" })).toThrow(MeetingGateError);
    expect(meeting.chunk({ sessionId, speaker: "prospect", text: "hello" }).phase).toBe("listening");
  });

  test("labels segments with the real speaker (mixed-mode audio() segments stay unlabelled)", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const meeting = meetingMode({ store: meetingStore(root), transcribe: async () => ({ text: "unlabelled", ms: 10 }), llm: async () => ({ text: COACH_JSON, model: "fake" }) });
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    meeting.chunk({ sessionId, speaker: "me", text: "so it's four hundred and ninety nine a month", ms: 50 });
    meeting.chunk({ sessionId, speaker: "prospect", text: "that's too expensive for us right now", ms: 60 });
    await meeting.audio({ sessionId, audio: wav() });
    expect(meeting._state().segments).toEqual([
      "[me] so it's four hundred and ninety nine a month",
      "[prospect] that's too expensive for us right now",
      "unlabelled",
    ]);
  });

  test("chunk() maps 'me'/'prospect' to the ChunkSpeaker cloud classification expects, so only the prospect's words are ever eligible", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const classified: Array<{ speaker: string; text: string }> = [];
    const meeting = meetingMode({
      store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), llm: async () => ({ text: COACH_JSON, model: "fake" }),
      cloudClassify: async (input) => (classified.push({ speaker: input.speaker, text: input.text }), null),
    });
    const { sessionId } = meeting.start();
    meeting.consent({ sessionId, answer: "agreed" });
    meeting.setCues(true);
    meeting.setCloudCues(true, { disclosed: true });
    meeting.chunk({ sessionId, speaker: "me", text: "our price is four ninety nine a month", ms: 50 });
    meeting.chunk({ sessionId, speaker: "prospect", text: "that's too expensive for us right now", ms: 60 });
    await new Promise((r) => setTimeout(r, 0));
    // session.ts hands both through with the right label; objection-jev.ts's own guardrail
    // (objection-jev.test.ts) is what actually abstains on anything but "prospect".
    expect(classified).toEqual([
      { speaker: "founder", text: "our price is four ninety nine a month" },
      { speaker: "prospect", text: "that's too expensive for us right now" },
    ]);
  });

  test("captureMode and levels are on status(), default to mixed/zero, and levels clamp to 0..1", () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const meeting = meetingMode({ store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), llm: async () => ({ text: COACH_JSON, model: "fake" }) });
    expect(meeting.status().captureMode).toBe("mixed");
    expect(meeting.status().levels).toEqual({ me: 0, prospect: 0 });
    meeting.setCaptureMode("two-channel");
    meeting.setLevels(0.6, 1.4);
    expect(meeting.status().captureMode).toBe("two-channel");
    expect(meeting.status().levels).toEqual({ me: 0.6, prospect: 1 });
  });

  test("probeCapture (device enumeration only) runs while consent is pending, and its result is in place before listening starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    let resolveProbe: (mode: "two-channel" | "mixed") => void = () => {};
    const meeting = meetingMode({
      store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), llm: async () => ({ text: COACH_JSON, model: "fake" }),
      probeCapture: () => new Promise((r) => (resolveProbe = r)),
    });
    const { sessionId } = meeting.start();
    expect(meeting.status().captureMode).toBe("mixed"); // the probe hasn't resolved yet
    resolveProbe("two-channel");
    await new Promise((r) => setTimeout(r, 0));
    expect(meeting.status().captureMode).toBe("two-channel");
    meeting.consent({ sessionId, answer: "agreed" });
    expect(meeting.status().captureMode).toBe("two-channel");
  });

  test("onListeningStart fires only once 'they agreed' (never during consent), onListeningEnd on stop and on end", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const events: string[] = [];
    const meeting = meetingMode({
      store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), llm: async () => ({ text: COACH_JSON, model: "fake" }),
      probeCapture: async () => "two-channel", onListeningStart: (id) => events.push(`start:${id}`), onListeningEnd: () => events.push("end"),
    });
    const { sessionId } = meeting.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([]); // consent pending: capture must not open yet
    meeting.consent({ sessionId, answer: "agreed" });
    expect(events).toEqual([`start:${sessionId}`]);
    meeting.stop();
    expect(events).toEqual([`start:${sessionId}`, "end"]);
  });

  test("onListeningEnd fires from end() too, and never twice for one call", async () => {
    const root = mkdtempSync(join(tmpdir(), "meeting-"));
    const events: string[] = [];
    const meeting = meetingMode({
      store: meetingStore(root), transcribe: async () => ({ text: "", ms: 0 }), llm: async () => ({ text: COACH_JSON, model: "fake" }),
      probeCapture: async () => "two-channel", onListeningStart: () => events.push("start"), onListeningEnd: () => events.push("end"),
    });
    const { sessionId } = meeting.start();
    await new Promise((r) => setTimeout(r, 0));
    meeting.consent({ sessionId, answer: "agreed" });
    meeting.chunk({ sessionId, speaker: "prospect", text: "hello", ms: 10 });
    await meeting.end();
    expect(events).toEqual(["start", "end"]);
  });
});

describe("voice rules", () => {
  test("meeting phrases become one `meeting` tool call; consent answers only while pending", async () => {
    const { freeVoice } = await import("../free-voice");
    let gate: "idle" | "consent" | "listening" = "idle";
    const voice = freeVoice(mkdtempSync(join(tmpdir(), "fv-")), {
      key: () => "", fetch: (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch, meetingGate: () => gate,
    });
    const turn = async (content: string) => (await voice.handle("/voice/free/turn", { messages: [{ role: "user", content }] })) as any;
    const first = await turn("Jarvis, meeting mode for Smile Dental");
    expect(first.model).toBe("rules");
    expect(first.tool_calls[0].function).toEqual({ name: "meeting", arguments: JSON.stringify({ action: "start", lead: "Smile Dental" }) });
    gate = "consent";
    expect((await turn("they agreed")).tool_calls[0].function.arguments).toBe(JSON.stringify({ action: "agreed" }));
    // The tool's result is the spoken line; no model is asked to improvise around consent.
    const follow = (await voice.handle("/voice/free/turn", {
      messages: [
        { role: "user", content: "they said no" },
        { role: "assistant", content: null, tool_calls: [{ id: "r1", type: "function", function: { name: "meeting", arguments: '{"action":"declined"}' } }] },
        { role: "tool", tool_call_id: "r1", content: "Understood. Nothing will be captured." },
      ],
    })) as any;
    expect(follow).toMatchObject({ content: "Understood. Nothing will be captured.", model: "rules" });
    expect((await turn("coach my last Granola meeting")).tool_calls[0].function.name).toBe("meeting");
  });
});
