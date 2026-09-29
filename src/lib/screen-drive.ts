// "Jarvis is driving… say stop" / "Jarvis is teaching… say next or stop": the client-side state of
// a running screen_act loop or lesson, for the pill (screen-drive-pill.tsx) and the tab title. The
// work itself runs on the server (scripts/screen-hands); stopping here aborts its request and calls
// /screen/stop as well, which also ends a lesson and hides the Jarvis cursor.
import { maskGoal } from "./agent-feed";
import { operatorRequest } from "./operator";

export type DriveMode = "driving" | "teaching" | "watching";
export type DriveState = { on: boolean; goal: string; step: string; mode: DriveMode };

let state: DriveState = { on: false, goal: "", step: "", mode: "driving" };
let abortCurrent: (() => void) | null = null;
const listeners = new Set<(s: DriveState) => void>();

export function driveState(): DriveState {
  return state;
}

export function subscribeDrive(listener: (s: DriveState) => void) {
  listeners.add(listener);
  listener(state);
  return () => void listeners.delete(listener);
}

function set(next: DriveState) {
  state = next;
  for (const listener of listeners) listener(state);
}

/** A run started; `abort` cancels its request (the server stops between any two sub-steps). */
export function startDriving(goal: string, abort: () => void, mode: DriveMode = "driving") {
  abortCurrent = abort;
  set({ on: true, goal: maskGoal(goal, 120), step: "", mode });
}

/** A lesson switched between teaching (he clicks) and driving (Jarvis acts), or moved on a step. */
export function setDriveMode(mode: DriveMode, step?: string) {
  if (state.on) set({ ...state, mode, ...(step !== undefined ? { step: step.slice(0, 80) } : {}) });
}

export function drivingStep(step: string) {
  if (state.on) set({ ...state, step: step.slice(0, 80) });
}

export function stopDrivingState() {
  abortCurrent = null;
  if (state.on) set({ on: false, goal: "", step: "", mode: "driving" });
}

/** The pill's Stop button: abort the request and tell the server to stop every loop now. */
export async function stopDriving() {
  abortCurrent?.();
  stopDrivingState();
  await operatorRequest("/screen/stop", {}).catch(() => undefined);
}

const MARKS: Record<DriveMode, string> = {
  driving: "● Jarvis is driving · say stop — ",
  teaching: "● Jarvis is teaching · say next or stop — ",
  watching: "● Jarvis is watching · say stop watching — ",
};

/** The tab title while driving or teaching, so the taskbar shows it when the OS is behind his app. */
export function drivingTitle(title: string, on: boolean, mode: DriveMode = "driving") {
  let bare = title;
  for (const mark of Object.values(MARKS)) if (bare.startsWith(mark)) bare = bare.slice(mark.length);
  return on ? `${MARKS[mode]}${bare}` : bare;
}
