// Feature flags for the screen-hands hardening pass (26 Sep). Every one is OFF by default (so the
// hands behave exactly as before until the owner turns one on), except jevIrreversible (ON since the
// 27 Sep night safety fix: it only ever adds a spoken-yes question).
//
//   recheck          Right before any SendInput click, re-read the UIA element under the point and
//                    compare its role, name, AutomationId and rectangle with the chosen target; read
//                    back where the pointer landed and which window owns that point. A mismatch is
//                    refused (STALE_REF) and the tree is read again.
//   jevIrreversible  Before a click (or Enter/Space on a focused button), ask Jev "can this be
//                    undone?". It can only ADD a spoken-yes gate on top of FINAL_BUTTON.
//   denylist         Password managers, Windows credential/UAC/sign-in prompts and secure fields are
//                    off limits; lock, log-off, shut-down and Run chords are never pressed.
//   refs             Snapshot-scoped targets: look-alike controls nobody could settle end the run
//                    with a question (AMBIGUOUS_TARGET) instead of a best guess.
//   cdp              On request, start an Electron app (VS Code, Slack, Obsidian, Discord) with a
//                    loopback-only DevTools port, so its web content is driven through CDP.
//   jevStep          Open goals: one Jev call per step picks the operation and a target together;
//                    used at >= 0.6 confidence, else the Groq planner decides as before.
//   formFill         "Fill this form with my business details": every empty field matched to a
//                    saved detail in one Jev call, typed and read back; the submit is never pressed.
//   replay           Lessons: a take-over whose every step was confirmed on screen is saved, and
//                    the same task later replays with no model call (Jev only repairs a stale target).
//   jevControl       Jev is the main decision-maker (owner, 27 Sep): every screen_act step asks Jev
//                    the next action, the target, whether the last step worked and whether the goal
//                    is complete (jev-control.ts); code executes and verifies. ON by default whenever
//                    a Jev key is configured; JARVIS_SCREEN_JEV_CONTROL=0 turns it off.
//
// Turn them on with environment variables on the OS server (JARVIS_SCREEN_RECHECK=1, …, or
// JARVIS_SCREEN_HARDENED=1 for all of them), or without a restart in
// .operator-data/screen-hands-flags.json: {"recheck": true, "denylist": true}. The environment wins.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirFor } from "../cloud/data-dir";

export type ScreenFlags = { recheck: boolean; jevIrreversible: boolean; denylist: boolean; refs: boolean; cdp: boolean; jevStep: boolean; formFill: boolean; replay: boolean; jevControl: boolean };
export const FLAG_NAMES = ["recheck", "jevIrreversible", "denylist", "refs", "cdp", "jevStep", "formFill", "replay", "jevControl"] as const satisfies ReadonlyArray<keyof ScreenFlags>;
export const FLAGS_OFF: ScreenFlags = { recheck: false, jevIrreversible: false, denylist: false, refs: false, cdp: false, jevStep: false, formFill: false, replay: false, jevControl: false };
/** What the live server starts from. jevControl is OFF at the 27 Sep stop: the Jev loop is unfinished
 * and untested (docs/SCREEN-CONTROL.md, STATUS at stop). jevIrreversible is ON by default (review
 * REVIEW-JEV finding 2, 27 Sep night): it can only ADD a spoken-yes question, never remove one, and
 * without a Jev key it asks nothing. The flags file or JARVIS_SCREEN_JEV_IRREVERSIBLE=0 still turn it off. */
export const FLAG_DEFAULTS: ScreenFlags = { ...FLAGS_OFF, jevIrreversible: true };

const ENV: Record<keyof ScreenFlags, string> = {
  recheck: "JARVIS_SCREEN_RECHECK",
  jevIrreversible: "JARVIS_SCREEN_JEV_IRREVERSIBLE",
  denylist: "JARVIS_SCREEN_DENYLIST",
  refs: "JARVIS_SCREEN_REFS",
  cdp: "JARVIS_SCREEN_CDP",
  jevStep: "JARVIS_SCREEN_JEV_STEP",
  formFill: "JARVIS_SCREEN_FORM_FILL",
  replay: "JARVIS_SCREEN_REPLAY",
  jevControl: "JARVIS_SCREEN_JEV_CONTROL",
};
export const FLAGS_FILE = join(dataDirFor(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")), "screen-hands-flags.json");

/** "1", "true", "on", "yes" → true; "0", "false", "off", "no" → false; anything else → undefined. */
function truthy(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return undefined;
}

/** The flags from a file's JSON (only known boolean keys) and the environment, which wins. Pure. */
export function resolveFlags(env: Record<string, string | undefined>, file: unknown = null): ScreenFlags {
  const out: ScreenFlags = { ...FLAG_DEFAULTS };
  const fromFile = file && typeof file === "object" && !Array.isArray(file) ? (file as Record<string, unknown>) : {};
  const all = truthy(env.JARVIS_SCREEN_HARDENED);
  for (const name of FLAG_NAMES) {
    const f = truthy(fromFile[name]);
    if (f !== undefined) out[name] = f;
    if (all !== undefined) out[name] = all;
    const e = truthy(env[ENV[name]]);
    if (e !== undefined) out[name] = e;
  }
  return out;
}

let cached: { mtime: number; json: unknown } | null = null;
function readFlagsFile(path: string): unknown {
  try {
    const mtime = statSync(path).mtimeMs;
    if (cached?.mtime === mtime) return cached.json;
    const json = JSON.parse(readFileSync(path, "utf8"));
    cached = { mtime, json };
    return json;
  } catch {
    return null;
  }
}

/** The live flags: read at call time, so a change to the flags file needs no restart. */
export function screenFlags(env: Record<string, string | undefined> = process.env, path = FLAGS_FILE): ScreenFlags {
  return resolveFlags(env, readFlagsFile(path));
}

/** For the report and the status route: which are on. */
export const describeFlags = (flags: ScreenFlags) => FLAG_NAMES.filter((n) => flags[n]).join(", ") || "none";
export const flagsFileIn = (root: string) => join(dataDirFor(root), "screen-hands-flags.json");
