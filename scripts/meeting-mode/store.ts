// What meeting mode keeps on disk, and nothing else (docs/MEETING-MODE.md):
// - consent.jsonl: one line per consent answer (time, lead, his confirmation; never audio);
// - notes/<id>.json + .md: the structured notes and coaching (never a transcript);
// - notes/<id>.transcript.txt: only when he said "keep the transcript" for that one call.
// Audio has no writer here at all.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderNotes, type MeetingNotes } from "./coach";

export type ConsentRecord = {
  at: string;
  sessionId: string;
  answer: "agreed" | "declined";
  lead: { id: number; name: string } | null;
  leadRef: string;
  confirmation: string;
  by: string;
  channel: "voice" | "hud" | "cli";
  audioStored: false;
};

/** Sending speech to Jev's cloud API is a distinct action from local-recording consent above —
 *  logged the same way (time, session, who), never with any transcript text. */
export type CloudCuesConsentRecord = { at: string; sessionId: string; on: boolean; by: string };

/** A cue that was actually shown, local or cloud-sourced. Only the label and a timestamp — never
 *  the transcript text that triggered it (Ministry guardrail for candidate #2). */
export type CueLogRecord = { at: string; sessionId: string; tag: string; source: "local" | "cloud" };

export type Writer = { write: (file: string, text: string) => void; append: (file: string, text: string) => void };
export const fsWriter: Writer = {
  write: (file, text) => writeFileSync(file, text, { mode: 0o600 }),
  append: (file, text) => appendFileSync(file, text, { mode: 0o600 }),
};

export function meetingStore(root: string, writer: Writer = fsWriter) {
  const dir = join(root, ".operator-data", "meeting-mode");
  const notesDir = join(dir, "notes");
  const ensure = () => mkdirSync(notesDir, { recursive: true, mode: 0o700 });
  const safeId = (id: string) => {
    if (!/^[a-z0-9-]{6,64}$/i.test(id)) throw new Error("Invalid notes id.");
    return id;
  };
  return {
    dir,
    logConsent(record: ConsentRecord) {
      ensure();
      writer.append(join(dir, "consent.jsonl"), JSON.stringify(record) + "\n");
    },
    consents(): ConsentRecord[] {
      const file = join(dir, "consent.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    logCloudCuesOptIn(record: CloudCuesConsentRecord) {
      ensure();
      writer.append(join(dir, "cloud-cues-consent.jsonl"), JSON.stringify(record) + "\n");
    },
    cloudCuesOptIns(): CloudCuesConsentRecord[] {
      const file = join(dir, "cloud-cues-consent.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    /** Label + timestamp only — never the transcript text that triggered the cue. */
    logCue(record: CueLogRecord) {
      ensure();
      writer.append(join(dir, "cue-log.jsonl"), JSON.stringify(record) + "\n");
    },
    cueLog(): CueLogRecord[] {
      const file = join(dir, "cue-log.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    saveNotes(notes: MeetingNotes) {
      ensure();
      const id = safeId(notes.id);
      writer.write(join(notesDir, `${id}.json`), JSON.stringify(notes, null, 2));
      writer.write(join(notesDir, `${id}.md`), renderNotes(notes));
    },
    saveTranscript(id: string, text: string) {
      ensure();
      writer.write(join(notesDir, `${safeId(id)}.transcript.txt`), text);
    },
    notes(id: string): MeetingNotes | null {
      const file = join(notesDir, `${safeId(id)}.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    },
    list(limit = 20): MeetingNotes[] {
      if (!existsSync(notesDir)) return [];
      return readdirSync(notesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(notesDir, f), "utf8")) as MeetingNotes)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit);
    },
  };
}

export type MeetingStore = ReturnType<typeof meetingStore>;
