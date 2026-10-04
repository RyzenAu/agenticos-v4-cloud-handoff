// /__operator/meeting/* (docs/MEETING-MODE.md). Local, or a signed-in person over Tailscale Serve
// (the iPhone web app at :8443); the operator plugin has already checked the page token.
import { renderNotes } from "./coach";
import { MeetingGateError, type Channel, type MeetingMode } from "./session";
import type { MeetingStore } from "./store";

type Ctx = { person?: string | null };

export function meetingApi(meeting: MeetingMode, store: MeetingStore) {
  const who = (ctx: Ctx, body: any) => {
    const named = String(body?.by ?? ctx.person ?? "usman").toLowerCase();
    return ["usman", "mehroz"].includes(named) ? named : "usman";
  };
  const channel = (value: unknown): Channel => (value === "voice" || value === "cli" ? value : "hud");

  /** One entry point for the voice tool: returns the line Jarvis should say (maybe empty). */
  async function voice(body: any, ctx: Ctx) {
    const action = String(body?.action ?? "");
    const by = who(ctx, body);
    switch (action) {
      case "start":
        return meeting.start({ lead: body?.lead ?? null, by });
      case "agreed":
      case "declined":
        return meeting.consent({ answer: action, confirmation: body?.text || (action === "agreed" ? "they agreed" : "they said no"), by, channel: "voice" });
      case "script":
        return { ...meeting.status(), say: `Say this to them: ${meeting.status().script}` };
      case "stop":
        return meeting.stop();
      case "end":
        return meeting.end({ keepTranscript: body?.keepTranscript === true });
      case "cues_on":
      case "cues_off":
        return { ...meeting.setCues(action === "cues_on"), say: action === "cues_on" ? "Cue cards on." : "Cue cards off." };
      case "cloud_cues_on":
        // Reaching this action at all (meeting-words.ts) already required his own words
        // confirming he told the other party — that phrase IS the disclosure.
        return meeting.setCloudCues(true, { disclosed: true });
      case "cloud_cues_off":
        return meeting.setCloudCues(false);
      case "keep_transcript":
        return meeting.keepTranscript(true);
      case "debrief":
        return meeting.debrief({ text: String(body?.text ?? ""), lead: body?.lead ?? null, by });
      case "granola":
        return meeting.granola({ query: body?.text ?? "", lead: body?.lead ?? null, by });
      case "last": {
        const status = meeting.status();
        return { ...status, say: status.lastNotesId ? "The last call's notes are on screen." : "There are no call notes yet." };
      }
      default:
        throw new MeetingGateError(`Unknown meeting action "${action}".`, 400);
    }
  }

  const POST_ROUTES = new Set([
    "/meeting/voice", "/meeting/start", "/meeting/consent", "/meeting/audio", "/meeting/cues", "/meeting/cloud-cues",
    "/meeting/keep", "/meeting/stop", "/meeting/end", "/meeting/debrief", "/meeting/granola", "/meeting/log",
  ]);

  async function handle(path: string, method: string, body: any, ctx: Ctx = {}) {
    if (method === "GET" && path === "/meeting/status") return meeting.status();
    if (method === "GET" && path === "/meeting/notes")
      return { notes: store.list(20).map((n) => ({ id: n.id, title: n.title, at: n.at, source: n.source, score: n.coaching.score, lead: n.lead })) };
    if (method === "GET" && path.startsWith("/meeting/notes/")) {
      const notes = store.notes(decodeURIComponent(path.slice("/meeting/notes/".length)));
      if (!notes) throw new MeetingGateError("No notes with that id.", 404);
      return { notes, markdown: renderNotes(notes) };
    }
    // Audit F5 P2-9: a wrong method is 405 and an unknown route 404, not the gate's 409.
    if (method !== "POST") {
      if (POST_ROUTES.has(path)) throw new MeetingGateError("Use POST.", 405);
      if (path === "/meeting/status" || path === "/meeting/notes" || path.startsWith("/meeting/notes/")) throw new MeetingGateError("Use GET.", 405);
      throw new MeetingGateError("Not found.", 404);
    }
    switch (path) {
      case "/meeting/voice":
        return voice(body, ctx);
      case "/meeting/start":
        return meeting.start({ lead: body?.lead ?? null, by: who(ctx, body) });
      case "/meeting/consent":
        return meeting.consent({ sessionId: body?.sessionId, answer: body?.answer, confirmation: body?.confirmation, by: who(ctx, body), channel: channel(body?.channel) });
      case "/meeting/audio":
        return meeting.audio({ sessionId: body?.sessionId, audio: body?.audio });
      case "/meeting/cues":
        return meeting.setCues(body?.on === true);
      case "/meeting/cloud-cues":
        // The HUD must show the disclosure text (objection-jev.ts's guardrail comment) before
        // ever sending `disclosed: true` here.
        return meeting.setCloudCues(body?.on === true, { disclosed: body?.disclosed === true });
      case "/meeting/keep":
        return meeting.keepTranscript(body?.on !== false);
      case "/meeting/stop":
        return meeting.stop(body?.sessionId);
      case "/meeting/end":
        return meeting.end({ sessionId: body?.sessionId, keepTranscript: body?.keepTranscript === true });
      case "/meeting/debrief":
        return meeting.debrief({ text: String(body?.text ?? ""), lead: body?.lead ?? null, by: who(ctx, body) });
      case "/meeting/granola":
        return meeting.granola({ query: body?.query ?? "", lead: body?.lead ?? null, by: who(ctx, body) });
      case "/meeting/log":
        return meeting.logToLead({ notesId: String(body?.notesId ?? ""), lead: body?.lead });
    }
    if (path === "/meeting/status" || path === "/meeting/notes" || path.startsWith("/meeting/notes/")) throw new MeetingGateError("Use GET.", 405);
    throw new MeetingGateError("Not found.", 404);
  }

  return { handle, voice };
}

