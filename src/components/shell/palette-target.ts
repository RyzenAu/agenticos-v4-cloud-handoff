// Where a palette entry will act, in words, shown on every row before anything runs. Pages open in this
// window, websites in a new tab of this browser, and apps and files on a device (the device is resolved
// by /__commands/target and only named once that answer is in; until then the row says so, never a guess).
// Pure; bun-tested.
import type { CommandEntry, TargetPreview } from "@/lib/commands/types";

export type EntryTarget = { kind: "window" | "tab" | "device" | "jarvis"; text: string; ok: boolean };

export function entryTarget(entry: Pick<CommandEntry, "id" | "action">, preview?: TargetPreview | null, checking = false): EntryTarget {
  if (entry.id === "rule:ask-jarvis") return { kind: "jarvis", text: "Answered here by Jarvis", ok: true };
  const a = entry.action;
  if (a.type === "navigate") return { kind: "window", text: "Opens in this window", ok: true };
  if (a.type === "open-url") return { kind: "tab", text: "New tab in this browser", ok: true };
  if (preview) return preview.ok ? { kind: "device", text: `Runs on ${preview.label} (${preview.owner})`, ok: true } : { kind: "device", text: `Won't run: ${preview.reason}`, ok: false };
  return { kind: "device", text: checking ? "Checking which device…" : "Runs on a device; shown before it runs", ok: true };
}
