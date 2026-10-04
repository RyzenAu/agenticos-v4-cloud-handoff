/** Launch or reuse an app, then verify its own window is in front. */
import { windowIsApp, type WindowInfo } from "../jarvis-skills/windows";
type AppReply = { ok: boolean; said: string; checkedAt?: number };
export type AppOpenDeps = {
  windows(): Promise<WindowInfo[]>;
  foreground(): Promise<WindowInfo | null>;
  focus(handle: number): Promise<unknown>;
  launch(name: string): Promise<{ ok: boolean; said: string }>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
};
export async function openVerifiedApp(
  name: string,
  signal: AbortSignal,
  deps: AppOpenDeps,
): Promise<AppReply> {
  const stopped = () => ({
    ok: false,
    said: `Stopped. Windows may still open ${name}; no later steps ran.`,
  });
  if (signal.aborted) return { ok: false, said: "Stopped before anything opened." };
  const matches = (w: WindowInfo) => windowIsApp(name.toLowerCase().trim(), w.process);
  const bring = async (w: WindowInfo): Promise<AppReply> => {
    if (signal.aborted) return stopped();
    await deps.focus(w.handle).catch(() => false);
    for (let i = 0; i < 5; i++) {
      if (signal.aborted) return stopped();
      const front = await deps.foreground().catch(() => null);
      if (front?.handle === w.handle && matches(front))
        return { ok: true, said: `Opened ${name}.`, checkedAt: (deps.now ?? Date.now)() };
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(100);
    }
    return { ok: false, said: `I found ${name}, but couldn't bring its window to the front.` };
  };
  const existing = (await deps.windows().catch(() => [])).find(matches);
  if (signal.aborted) return { ok: false, said: "Stopped before anything opened." };
  if (existing) return bring(existing);
  const launched = await deps.launch(name);
  if (!launched.ok) return launched;
  for (let i = 0; i < 30; i++) {
    if (signal.aborted) return stopped();
    const found = (await deps.windows().catch(() => [])).find(matches);
    if (found) return bring(found);
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(300);
  }
  return {
    ok: false,
    said: `I asked Windows to start ${name}, but couldn't verify its window. No later steps ran.`,
  };
}
