/** String transport for screen_act; confirmation results retain CONFIRM_MARK. */
export type ScreenResult = {
  type: "screen_result";
  ok: boolean;
  said: string;
  outcome?: "unverified" | "step_limit" | "no_progress";
  ask?: boolean;
  stopped?: boolean;
};

export function parseScreenResult(content: string): ScreenResult | null {
  try {
    const value = JSON.parse(content);
    if (value?.type === "screen_result" && typeof value.ok === "boolean" && typeof value.said === "string") return value;
  } catch { /* Legacy plain spoken result. */ }
  return null;
}

/** A jarvis_command tool result (src/lib/jarvis-command.ts commandResultText): same pause rule as screen_act. */
function commandResult(content: string): ScreenResult | null {
  try {
    const v = JSON.parse(content);
    if (v?.type === "command_result" && typeof v.ok === "boolean" && typeof v.said === "string")
      return { type: "screen_result", ok: v.ok, said: v.said, ...(v.ask ? { ask: true } : {}), ...(v.stopped ? { stopped: true } : {}), ...(v.ok ? {} : { outcome: "unverified" as const }) };
  } catch { /* not a command result */ }
  return null;
}

export function screenResultPause(name: string, content: string): string | null {
  // A command that asked, stopped or didn't verify pauses the rest of the batch, exactly like screen_act.
  const result = name === "screen_act" ? parseScreenResult(content) : name === "jarvis_command" ? commandResult(content) : null;
  if (!result || (result.ok && !result.ask && !result.stopped && !result.outcome)) return null;
  return result.said.trim() || "I stopped there. What would you like me to do next?";
}

/** Execute in order, recording explicit skipped results so the next user turn has valid history. */
export async function runVoiceToolBatch<T extends { id: string; function: { name: string } }>(
  calls: T[], run: (call: T) => Promise<string>, record: (id: string, content: string) => void,
): Promise<string | null> {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const content = await run(call);
    record(call.id, content);
    const pause = screenResultPause(call.function.name, content);
    if (pause !== null) {
      for (const skipped of calls.slice(i + 1)) record(skipped.id, "Not run: screen action needs new user direction.");
      return pause;
    }
  }
  return null;
}
