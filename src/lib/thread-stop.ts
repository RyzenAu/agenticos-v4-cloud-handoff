// Stop a job from the Jarvis conversation (frontend). Uses the hub's own cancel routes; the words are what the hub confirmed.
import { cancelCommand, stopSaid } from "@/lib/jarvis-command";
import { codingClient } from "@/lib/coding-client";

/**
 * Stop a job from the conversation: the hub's own cancel (the same one "stop that task" uses), a coding job through its page's stop.
 * The words are the hub's outcome ("Stopped." only when it confirmed), never a local guess.
 */
export async function stopJobFromThread(jobId: string, deps: { cancel?: typeof cancelCommand; coding?: (id: string) => Promise<{ job?: { state?: string } }> } = {}): Promise<string> {
  const reply = await (deps.cancel ?? cancelCommand)({ jobId });
  if (reply.outcome !== "no-job") return stopSaid(reply, { hadJob: true, mayHaveArrived: false }).said;
  try {
    const r = await (deps.coding ?? ((id) => codingClient.cancel(id) as Promise<{ job?: { state?: string } }>))(jobId);
    const state = r?.job?.state;
    if (state === "cancelled") return "Stopped.";
    if (state === "completed" || state === "failed") return `It had already ${state === "completed" ? "finished" : "failed"} before the stop arrived.`;
    return "Stop requested; not yet confirmed. Check the job before trusting that it stopped.";
  } catch {
    return "Stop requested; not yet confirmed. It may still be running: check Activity.";
  }
}
