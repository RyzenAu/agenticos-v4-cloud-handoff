import { useEffect, useState } from "react";
import { getVoiceScope, onVoiceScope, type VoiceScope } from "./voice-scope";

/** The current voice scope, live (the panel re-labels itself when a bot's chat scopes voice, and again when it is cleared). */
export function useVoiceScope(): VoiceScope | null {
  const [scope, setScope] = useState<VoiceScope | null>(getVoiceScope);
  useEffect(() => {
    setScope(getVoiceScope());
    return onVoiceScope(setScope);
  }, []);
  return scope;
}
