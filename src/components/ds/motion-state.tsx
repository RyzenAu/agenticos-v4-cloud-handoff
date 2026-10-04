// State components that carry the OS's motion language (src/lib/ui-motion.ts, styles.css "Motion
// language"): a save confirmation, a task's start -> progress -> complete, a reconnect state and the
// device slot. Each animates transform/opacity only and is fully readable with motion off: the words
// always say the state, the movement only says it changed.
import { AlertCircle, Check, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SavePhase } from "@/lib/ui-motion";

/**
 * Save confirmation. Idle renders an empty live region (so a screen reader hears the next change);
 * "Saved" pops in once and the caller's `useSavePhase` returns to idle after a few seconds.
 */
export function SaveStatus({
  phase,
  saving = "Saving…",
  saved = "Saved",
  error = "Couldn't save. Your edit is still here; try again.",
  className,
}: {
  phase: SavePhase;
  saving?: string;
  saved?: string;
  error?: string;
  className?: string;
}) {
  return (
    <span role="status" aria-live="polite" data-phase={phase} className={cn("mo-save inline-flex min-h-6 items-center gap-1.5 text-xs", className)}>
      {phase === "saving" && <span className="text-muted-foreground">{saving}</span>}
      {phase === "saved" && (
        <span className="mo-pop inline-flex items-center gap-1.5 text-success">
          <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
          {saved}
        </span>
      )}
      {phase === "error" && (
        <span className="mo-pop inline-flex items-center gap-1.5 text-danger">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          {error}
        </span>
      )}
    </span>
  );
}

export type TaskPhaseName = "queued" | "running" | "waiting" | "done" | "failed";

const PHASE_WORD: Record<TaskPhaseName, string> = { queued: "Queued", running: "Running", waiting: "Needs you", done: "Done", failed: "Failed" };

/**
 * One task, start -> progress -> complete. The bar is a full-width track whose fill scales on the X axis
 * (`progress` 0..1), or slides while the length is unknown (`progress` null/undefined, running only).
 * It never implies a percentage it doesn't have.
 */
export function TaskPhase({
  phase,
  label,
  detail,
  progress,
  className,
}: {
  phase: TaskPhaseName;
  label: ReactNode;
  detail?: ReactNode;
  progress?: number | null;
  className?: string;
}) {
  return (
    <div className={cn("mo-task", className)} data-phase={phase}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 text-sm font-medium">{label}</span>
        <TaskWord phase={phase} />
      </div>
      {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
      <TaskBar phase={phase} progress={progress} label={typeof label === "string" ? label : "Task progress"} className="mt-2" />
    </div>
  );
}

/** The phase word ("Running", "Done"...) with the completion tick landing once. */
export function TaskWord({ phase, word, className }: { phase: TaskPhaseName; word?: string; className?: string }) {
  return (
    <span className={cn("mo-task-word inline-flex items-center gap-1.5 text-xs font-medium", className)} data-phase={phase}>
      {phase === "done" && <Check className="mo-pop h-4 w-4" strokeWidth={2.5} aria-hidden="true" />}
      {word ?? PHASE_WORD[phase]}
    </span>
  );
}

/** The bar alone: hidden for queued/failed, scales for a known fraction, slides for an unknown one. */
export function TaskBar({ phase, progress, label, className }: { phase: TaskPhaseName; progress?: number | null; label: string; className?: string }) {
  const known = typeof progress === "number" && Number.isFinite(progress);
  const fill = phase === "done" ? 1 : known ? Math.min(1, Math.max(0, progress as number)) : 0;
  const showBar = phase === "running" || phase === "done" || (phase === "waiting" && known);
  if (!showBar) return null;
  const indeterminate = phase === "running" && !known;
  return (
    <div
      className={cn("mo-track", className)}
      data-phase={phase}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(fill * 100)}
      aria-valuetext={indeterminate ? "In progress, length unknown" : undefined}
    >
      {indeterminate ? <span className="mo-fill mo-fill-indeterminate" /> : <span className="mo-fill" style={{ transform: `scaleX(${fill})` }} />}
    </div>
  );
}

export type ConnectionPhase = "live" | "reconnecting" | "offline";

const CONNECTION_WORD: Record<ConnectionPhase, string> = { live: "Live", reconnecting: "Reconnecting…", offline: "Offline" };

/** A link's state. Reconnecting breathes the dot (opacity only); live and offline hold still. */
export function ConnectionState({ state, label, detail, className }: { state: ConnectionPhase; label?: string; detail?: ReactNode; className?: string }) {
  return (
    <span role="status" data-state={state} className={cn("mo-conn inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <span className="mo-conn-dot" aria-hidden="true" />
      <span>{label ?? CONNECTION_WORD[state]}</span>
      {detail ? <span>· {detail}</span> : null}
    </span>
  );
}

export type DeviceSlotInput = {
  /** Stable id from the device registry, shown only when there is no friendlier label. */
  deviceId?: string | null;
  label?: string | null;
  /** True when the device is the machine running this OS. */
  isThisPc?: boolean | null;
  /** true online, false offline, null/undefined not reported: unknown is never drawn as offline. */
  online?: boolean | null;
};

export type DeviceSlotView = { name: string | null; state: "online" | "offline" | "unknown"; word: string };

const pick = (r: Record<string, unknown>, keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null);

/**
 * Reads whichever device fields a record happens to carry (the registry is still gaining them), all
 * optional: label (`label`/`deviceLabel`/`targetDeviceLabel`), online (`online`/`deviceOnline`/
 * `targetDeviceOnline`), this-PC (`isThisPc`/`thisPc`/`targetIsThisPc`) and the id (`deviceId`/`targetDeviceId`).
 */
export function deviceFromRecord(r: object | null | undefined): DeviceSlotInput {
  const rec = (r ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    deviceId: str(pick(rec, ["deviceId", "targetDeviceId"])),
    label: str(pick(rec, ["label", "deviceLabel", "targetDeviceLabel"])),
    isThisPc: bool(pick(rec, ["isThisPc", "thisPc", "targetIsThisPc"])),
    online: bool(pick(rec, ["online", "deviceOnline", "targetDeviceOnline"])),
  };
}

/** Pure: what the slot says. Kept separate so the wording is testable without rendering. */
export function deviceSlotView(d: DeviceSlotInput | null | undefined): DeviceSlotView {
  const name = d?.isThisPc ? "This PC" : d?.label?.trim() || d?.deviceId?.trim() || null;
  const state = d?.online === true ? "online" : d?.online === false ? "offline" : "unknown";
  return { name, state, word: state === "online" ? "Online" : state === "offline" ? "Offline" : "Status not reported" };
}

/**
 * Where a task runs: "This PC", the device's label, or a quiet "No device reported". Offline is named in
 * words and a hollow dot (not red: a powered-down laptop is normal), and an unreported status says so.
 */
export function DeviceStatusSlot({ device, className }: { device?: DeviceSlotInput | null; className?: string }) {
  const v = deviceSlotView(device);
  if (!v.name) return <span className={cn("mo-device text-xs text-muted-foreground", className)} data-state="unknown">No device reported</span>;
  return (
    <span className={cn("mo-device inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)} data-state={v.state} title={device?.deviceId ? `Device ${device.deviceId}` : undefined}>
      <Monitor className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="font-medium text-foreground">{v.name}</span>
      <span aria-hidden="true">·</span>
      <span className="mo-device-state">{v.word}</span>
    </span>
  );
}
