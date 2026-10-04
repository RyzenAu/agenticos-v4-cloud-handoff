/**
 * Which bot the open voice session is talking to. Set by a bot's chat (its voice button) before it opens the existing Jarvis voice client;
 * read by the voice tool path (`jarvis_command` in voice-companion.tsx), which then sends the bot's conversation id and `target: { bot }`
 * through `runJarvisCommand`. Null (the default) leaves every spoken request exactly as it was: the person's default Jarvis thread.
 *
 * It holds no audio and starts nothing; clearing it (the chat unmounts, the voice surface closes) puts voice back on the default thread.
 */
export type VoiceScope = { conversationId: string; bot: string; label: string };

let current: VoiceScope | null = null;
const listeners = new Set<(scope: VoiceScope | null) => void>();

export const getVoiceScope = (): VoiceScope | null => current;
export function setVoiceScope(scope: VoiceScope | null) {
  if (current?.conversationId === scope?.conversationId && current?.bot === scope?.bot) return;
  current = scope;
  for (const l of [...listeners]) {
    try {
      l(scope);
    } catch {
      /* a listener never breaks the scope */
    }
  }
}
export function onVoiceScope(listener: (scope: VoiceScope | null) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** What the voice tool adds to `runJarvisCommand` for the current scope (nothing when unscoped). */
export function voiceScopeCommandOptions(scope: VoiceScope | null = current): { conversationId?: string; target?: { bot: string } } {
  return scope ? { conversationId: scope.conversationId, target: { bot: scope.bot } } : {};
}

/** The words the voice panel uses for who is listening: the bot's name while a bot scope is active, Jarvis otherwise. */
export function voiceLabels(scope: VoiceScope | null = current) {
  const name = scope?.label?.trim() || "";
  return scope && name
    ? { who: name, idle: `Talking to ${name}`, start: `Talk to ${name}`, scoped: true as const }
    : { who: "Jarvis", idle: "Jarvis", start: "Talk to Jarvis", scoped: false as const };
}

/** A line of the voice conversation. An assistant turn keeps the name of whoever was speaking when it was created, so a later scope change never relabels it. */
export type SpokenTurn = { role: "user" | "assistant"; text: string; speaker?: string };

/** Make a turn; an assistant turn is stamped with the speaker for the scope it was created in (Jarvis, or the bot's name). */
export function newTurn(role: SpokenTurn["role"], text: string, scope: VoiceScope | null = current): SpokenTurn {
  return role === "assistant" ? { role, text, speaker: voiceLabels(scope).who } : { role, text };
}

/** Who to label a turn as: the person's name for their own turns, otherwise the speaker stored on the turn (the current scope's name only for a turn made before speakers were stored). */
export function speakerOf(turn: SpokenTurn, userName: string, fallbackWho: string): string {
  return turn.role === "user" ? userName || "You" : turn.speaker || fallbackWho;
}

/** The exported conversation, each turn under the name it was spoken as. */
export function transcriptSections(turns: SpokenTurn[], userName: string, fallbackWho: string): string {
  return turns.map((turn) => `## ${speakerOf(turn, userName, fallbackWho)}\n\n${turn.text}`).join("\n\n");
}
