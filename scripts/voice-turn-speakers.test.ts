// R7 review m9: each assistant turn keeps the name of whoever spoke it. Before, every turn took the CURRENT scope's name, so opening a
// bot's voice turned earlier Jarvis turns into "Research" (and the reverse), on screen and in the exported transcript.
// This runs the same functions the voice panel uses to create, label and export turns.
import { afterEach, expect, test } from "bun:test";
import { newTurn, setVoiceScope, speakerOf, transcriptSections, voiceLabels, type SpokenTurn } from "../src/lib/voice-scope";

afterEach(() => setVoiceScope(null));
const RESEARCH = { conversationId: "agent:usman:research", bot: "research", label: "Research" };

test("turns made before and after a bot scope opens keep their own speaker", () => {
  const turns: SpokenTurn[] = [];
  turns.push(newTurn("user", "Hello"));
  turns.push(newTurn("assistant", "Hi, Jarvis here."));
  setVoiceScope(RESEARCH);
  turns.push(newTurn("assistant", "Research here."));
  expect(turns.map((t) => t.speaker)).toEqual([undefined, "Jarvis", "Research"]);
  // With the scope now Research, the first reply still reads as Jarvis.
  const now = voiceLabels().who;
  expect(now).toBe("Research");
  expect(turns.map((t) => speakerOf(t, "Usman", now))).toEqual(["Usman", "Jarvis", "Research"]);
  // And the reverse: scope released, the Research turn stays Research.
  setVoiceScope(null);
  expect(speakerOf(turns[2]!, "Usman", voiceLabels().who)).toBe("Research");
});

test("the exported transcript uses the stored speakers", () => {
  const jarvis = newTurn("assistant", "First.");
  setVoiceScope(RESEARCH);
  const bot = newTurn("assistant", "Second.");
  const md = transcriptSections([jarvis, newTurn("user", "Question"), bot], "Usman", voiceLabels().who);
  expect(md).toBe("## Jarvis\n\nFirst.\n\n## Usman\n\nQuestion\n\n## Research\n\nSecond.");
});

test("a turn with no stored speaker falls back to the current name", () => {
  expect(speakerOf({ role: "assistant", text: "old" }, "", "Jarvis")).toBe("Jarvis");
  expect(speakerOf({ role: "user", text: "x" }, "", "Jarvis")).toBe("You");
});
