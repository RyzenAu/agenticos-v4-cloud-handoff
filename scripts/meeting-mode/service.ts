// Meeting mode, wired for real use: the OS server (scripts/operator-plugin.ts) and the CLI that
// Hermes' mu-call-coach skill runs from Telegram share this, so both coach identically.
import type { Database } from "bun:sqlite";
import { crmPath, openCrm } from "../leads/crm";
import { providerKey } from "../provider-config";
import { meetingApi } from "./api";
import { dualCapture } from "./capture";
import { subscriptionLlm } from "./llm";
import { classifyObjectionCues } from "./objection-jev";
import { meetingMode, type MeetingMode } from "./session";
import { meetingStore } from "./store";
import { localTranscriber } from "./transcriber";
import type { Llm } from "./coach";

export function meetingService(
  root: string,
  options: { recentGranola?: () => Promise<{ documents: Array<{ id: string; title: string; text: string }> }>; llm?: Llm } = {},
) {
  const store = meetingStore(root);
  const whisper = localTranscriber(root);
  let db: Database | null = null;
  const jevKey = () => providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY");
  // meeting is defined below; capture only ever calls meetingRef() once listening has actually
  // started, i.e. strictly after meetingMode() has returned and meetingRef has been assigned.
  let meetingRef: MeetingMode | null = null;
  const capture = dualCapture(root, { whisper, meeting: () => meetingRef! });
  const meeting = meetingMode({
    store,
    transcribe: (wav) => whisper.transcribe(wav),
    warm: () => whisper.warm(),
    llm: options.llm ?? subscriptionLlm(),
    crm: () => (db ??= openCrm(crmPath(root))),
    recentGranola: options.recentGranola,
    // candidate #2 (MINISTRY-JEV-BUSINESS.md): classifyObjectionCues() abstains unless the chunk
    // is attributed to the prospect. Two-channel capture (capture.ts, dual_capture.py) now
    // supplies that label for real on a computer call with loopback available; the mixed-mode
    // fallback (one browser mic, iPhone speaker, no loopback) still passes "unknown" and abstains
    // exactly as before this feature existed.
    cloudClassify: (input) => {
      const key = jevKey();
      return key ? classifyObjectionCues(input, { key }) : Promise.resolve(null);
    },
    shadowRoot: root,
    probeCapture: () => capture.probe(),
    onListeningStart: (sessionId) => capture.start(sessionId),
    onListeningEnd: () => capture.stop(),
  });
  meetingRef = meeting;
  return {
    meeting,
    store,
    whisper,
    api: meetingApi(meeting, store),
    close() {
      capture.stop();
      meeting.stop();
      db?.close();
      db = null;
    },
  };
}
