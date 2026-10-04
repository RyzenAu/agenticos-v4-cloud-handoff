/**
 * Meeting mode's words (docs/MEETING-MODE.md), shared by the server rules (scripts/free-voice.ts,
 * scripts/meeting-mode) and the voice client. Pure: no I/O.
 *
 * - CONSENT_SCRIPT: the one line the owner says to the other party before anything is captured.
 * - meetingIntent: what the owner said to Jarvis ("meeting mode for Smile Dental", "they agreed",
 *   "end meeting", "coach my last Granola meeting").
 * - inCallCommand: a spoken command inside the captured audio ("Jarvis, end meeting", "Jarvis,
 *   stop"). During a meeting the normal voice session is off, so this is how he steers it by voice.
 */

export const CONSENT_SCRIPT =
  "Just so you know, I use an AI note-taker so I don't miss anything. Are you happy with that?";

export type MeetingAction =
  | "start"
  | "agreed"
  | "declined"
  | "script"
  | "end"
  | "stop"
  | "cues_on"
  | "cues_off"
  | "cloud_cues_on"
  | "cloud_cues_off"
  | "keep_transcript"
  | "debrief"
  | "granola"
  | "last";

export type MeetingIntent = { action: MeetingAction; lead?: string; text?: string };

/** Where the meeting is, as far as the rules need to know. */
export type MeetingGate = "idle" | "consent" | "listening";

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const JARVIS = /^(?:hey |ok |okay )?jarvis\s*/;

/** "for Smile Dental" / "with lead 12" → "Smile Dental" / "12". */
function leadFrom(raw: string): string | undefined {
  const m = /\b(?:for|with|on)\s+(?:lead\s+)?(?:#\s*)?(.+?)[.?!]*$/i.exec(raw.trim());
  const lead = m?.[1]?.replace(/^(?:the|a|my)\s+/i, "").trim();
  if (!lead || /^(?:a |the )?(?:call|meeting|sales call|cold call|this call|me)$/i.test(lead)) return undefined;
  return lead.slice(0, 80);
}

/**
 * The owner's words to Jarvis. Anchored phrases only, so ordinary talk never trips it.
 * `gate` is the meeting's current state: consent answers only count while consent is pending,
 * and "stop"/"end" only while listening (a bare "stop" otherwise belongs to the voice client).
 */
export function meetingIntent(utterance: string, gate: MeetingGate = "idle"): MeetingIntent | null {
  const raw = utterance.trim();
  const t = clean(raw).replace(JARVIS, "");
  if (!t) return null;

  // Granola route (Zoom/Meet): "coach my last Granola meeting", "coach the Granola call with X".
  if (/^(?:please )?coach (?:me on )?(?:my |the )?(?:last |latest |most recent )?granola (?:meeting|call|notes?)\b/.test(t) ||
      /^(?:run|put) (?:my |the )?(?:last |latest )?granola (?:meeting|call) through (?:the )?coach(?:ing)?\b/.test(t)) {
    const about = /\b(?:with|about)\s+(.+)$/i.exec(raw)?.[1]?.replace(/[.?!]+$/, "").trim();
    return { action: "granola", ...(about ? { text: about.slice(0, 120) } : {}) };
  }
  // Post-call debrief (his own words; nothing captured): "debrief for Smile Dental: spoke to Sarah…".
  const spoken = raw.replace(/^(?:hey |ok |okay )?jarvis[,.!]?\s*/i, "");
  const debrief = /^(?:call )?debrief(?:\s+for\s+([^:,]+))?\s*[:,-]?\s+([\s\S]{12,})$/i.exec(spoken);
  if (debrief) return { action: "debrief", text: debrief[2].trim().slice(0, 6000), ...(debrief[1] ? { lead: debrief[1].trim() } : {}) };
  if (/^(?:read me |show me |what's |what is )?(?:the )?consent (?:line|script)\??$/.test(t)) return { action: "script" };
  if (/^(?:show |read )?(?:me )?(?:the )?notes (?:from|for) (?:my |the )?last (?:call|meeting)$|^(?:last|latest) (?:call|meeting) notes$/.test(t))
    return { action: "last" };

  if (gate === "consent") {
    if (/^(?:ok |okay |yep |yes |good )?(?:they|she|he) (?:agreed|said yes|are happy|is happy|consented|are fine|is fine|are ok|is ok|are okay|is okay)(?: with (?:it|that))?$|^(?:yes )?(?:they're|she's|he's) (?:happy|fine|ok|okay|good)(?: with (?:it|that))?$|^consent (?:given|confirmed)$/.test(t))
      return { action: "agreed" };
    if (/^(?:no )?(?:they|she|he) (?:said no|declined|refused|didn't agree|did not agree|don't want (?:it|that)|doesn't want (?:it|that)|aren't happy|isn't happy|are not happy|is not happy)(?: with (?:it|that))?$|^no consent$|^consent (?:refused|declined)$/.test(t))
      return { action: "declined" };
    if (/^(?:cancel|stop|never mind|forget it)(?: meeting mode)?$/.test(t)) return { action: "stop" };
  }
  if (/^(?:start |turn on |switch on |enter |begin )?meeting mode(?: on)?\b/.test(t) || /^(?:start |begin )(?:a )?(?:sales |cold )?call (?:coach|notes)\b/.test(t) ||
      /^(?:take notes|listen in) (?:on|for) (?:this|my|the) (?:call|meeting)\b/.test(t)) {
    if (/\b(?:off|stop|end)$/.test(t)) return { action: gate === "listening" ? "end" : "stop" };
    const lead = leadFrom(spoken.replace(/^.*?meeting mode(?: on)?/i, ""));
    return { action: "start", ...(lead ? { lead } : {}) };
  }
  // "End call mode" is the calling-block protocol, not this: a bare "call" only counts mid-meeting.
  if (/^(?:end|finish|wrap up|close) (?:the )?meeting(?: mode)?$|^meeting (?:over|done|finished)$/.test(t) ||
      (gate === "listening" && /^(?:end|finish|wrap up|close) (?:the )?call$|^(?:that's|thats) (?:the )?end of the (?:call|meeting)$/.test(t)))
    return { action: "end" };
  if (gate !== "idle" && /^(?:stop|stop listening|stop meeting mode|cancel meeting mode|stop taking notes)$/.test(t)) return { action: "stop" };
  if (/^(?:turn |switch )?(?:the )?cue cards? on$|^(?:show|turn on) (?:the )?cue cards?$/.test(t)) return { action: "cues_on" };
  if (/^(?:turn |switch )?(?:the )?cue cards? off$|^(?:hide|turn off) (?:the )?cue cards?$/.test(t)) return { action: "cues_off" };
  // Cloud cues send speech to Jev's cloud API — a distinct action from local-recording consent
  // above, so turning them on needs his own words confirming he told the other party, not just
  // "cues on" with "cloud" in front.
  if (/^i(?:'ve| have) told them,? (?:turn on |enable |allow )?cloud cues?(?: on)?$/.test(t)) return { action: "cloud_cues_on" };
  if (/^(?:turn off|disable|stop) cloud cues?$|^cloud cues? off$/.test(t)) return { action: "cloud_cues_off" };
  if (/^keep (?:the |this )?transcript(?: this time| for this call)?$/.test(t)) return { action: "keep_transcript" };
  return null;
}

/**
 * A spoken command inside the captured meeting audio, by transcript. Needs his name for it
 * ("Jarvis, end meeting", "Jarvis stop"), so the other party saying "stop" never ends anything,
 * except the unmistakable "stop recording" / "stop the note-taker", which always stops capture:
 * if anyone withdraws consent mid-call, capture ends at once.
 */
export function inCallCommand(segment: string): "end" | "stop" | "keep_transcript" | "cues_on" | "cues_off" | "cloud_cues_on" | "cloud_cues_off" | null {
  const t = clean(segment);
  if (/\b(?:stop|turn off|switch off|pause) (?:the )?(?:recording|recorder|note ?taker|ai|transcri(?:bing|ption)|listening)\b/.test(t)) return "stop";
  if (/\b(?:don't|do not) (?:record|want (?:to be |this )?recorded)\b|\bplease don't (?:record|transcribe)\b|\bi (?:don't|do not) consent\b/.test(t)) return "stop";
  const m = /\bjarvis\b[ ,]*(.{0,40})/.exec(t);
  if (!m) return null;
  const after = m[1];
  if (/^(?:please )?(?:end|finish|wrap up|close)(?: the)? (?:meeting|call)\b/.test(after) || /^(?:that's|thats) (?:the )?end\b/.test(after)) return "end";
  if (/^(?:please )?stop\b/.test(after)) return "stop";
  if (/^keep (?:the )?transcript\b/.test(after)) return "keep_transcript";
  // "I've told them, cloud cues on" said mid-call is itself his confirmation to the other party.
  if (/^i(?:'ve| have) told them,? (?:turn on |enable |allow )?cloud cues?(?: on)?\b/.test(after)) return "cloud_cues_on";
  if (/^(?:turn off|disable|stop) cloud cues?\b|^cloud cues? off\b/.test(after)) return "cloud_cues_off";
  if (/^cue cards? on\b|^(?:show|turn on) (?:the )?cue cards?\b/.test(after)) return "cues_on";
  if (/^cue cards? off\b|^(?:hide|turn off) (?:the )?cue cards?\b/.test(after)) return "cues_off";
  return null;
}

/** "12:34" for a duration in ms (h:mm:ss past an hour). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}
