// The voice button of a bot's chat: it scopes the EXISTING Jarvis voice client to this bot (its conversation id and target ride on every spoken
// request through the voice tool path, src/lib/voice-scope.ts) and opens it. Nothing is re-implemented here: turn-taking, endpointing, "stop" and
// the microphone all stay in voice-companion.tsx / free-voice-client.ts. While the voice surface is closed the scope is cleared, so spoken
// requests from anywhere else stay on the default thread.
import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ds";
import { onVoiceScope, setVoiceScope } from "@/lib/voice-scope";

export type VoiceStarter = (scope: { conversationId: string; bot: string; label: string }) => void;

/** Default: scope voice to the bot, then ask the existing voice client to open (the same event the "Talk" controls dispatch). */
export const startScopedVoice: VoiceStarter = (scope) => {
  setVoiceScope(scope);
  window.dispatchEvent(new CustomEvent("operator:voice"));
};

export function VoiceButton({ botId, botName, conversationId, start = startScopedVoice }: { botId: string; botName: string; conversationId: string; start?: VoiceStarter }) {
  const [open, setOpen] = useState(false);
  const [scoped, setScoped] = useState(false);

  useEffect(() => {
    const surface = (e: Event) => {
      const isOpen = !!(e as CustomEvent<{ open?: boolean }>).detail?.open;
      setOpen(isOpen);
      // The voice window closing returns voice to the default thread.
      if (!isOpen) setVoiceScope(null);
    };
    window.addEventListener("voice:surface", surface);
    const off = onVoiceScope((s) => setScoped(s?.conversationId === conversationId));
    return () => {
      window.removeEventListener("voice:surface", surface);
      off();
      // Leaving the page: this chat no longer owns voice.
      setVoiceScope(null);
    };
  }, [conversationId]);

  const live = open && scoped;
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 shrink-0 gap-2 px-4 text-sm"
      aria-pressed={live}
      aria-label={live ? `Voice is open: speak to ask ${botName}` : `Talk to ${botName}`}
      onClick={() => start({ conversationId, bot: botId, label: botName })}
    >
      <Mic aria-hidden="true" />
      <span className="hidden sm:inline">{live ? "Listening" : "Talk"}</span>
    </Button>
  );
}
