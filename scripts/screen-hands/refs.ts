// Snapshot-scoped targets (the idea from Agent Desktop's ref contract, none of its code).
//
// Every element Jarvis acts on comes from one numbered snapshot of the window. A ref such as
// "@s4e17" means element 17 *of snapshot 4*; it's resolved only against that snapshot, and
// never silently re-bound to whatever sits at the same place later:
//
//   STALE_REF         the snapshot it came from is gone, the element isn't in it, or the control
//                     under the point right before input is not the one chosen (re-read the tree);
//   AMBIGUOUS_TARGET  his words fit two or more different controls and nothing settled which, so
//                     he's asked rather than a guess being clicked.
//
// Pure (no Windows), unit tested in refs.test.ts.
import { labelOf, type Snapshot, type UiElement } from "./plan";

export type RefCode = "STALE_REF" | "AMBIGUOUS_TARGET";

export class RefError extends Error {
  constructor(
    readonly code: RefCode,
    message: string,
    /** AMBIGUOUS_TARGET: the look-alikes, for the question back. */
    readonly options: UiElement[] = [],
  ) {
    super(message);
    this.name = "RefError";
  }
}
export const isRefError = (error: unknown, code?: RefCode): error is RefError => error instanceof RefError && (!code || error.code === code);

export type Scoped = Snapshot & { sid: number };
let next = 0;
/** Number a fresh snapshot; refs taken from it name this number. */
export function scope(snap: Snapshot): Scoped {
  return { ...snap, sid: ++next };
}
export const refOf = (snap: Scoped, e: Pick<UiElement, "id">) => `@s${snap.sid}e${e.id}`;

/** "@s4e17" → element 17 of snapshot 4, or a bare id (the planner's) against `current`. */
export function resolveRef(ref: string | number, current: Scoped): UiElement {
  let sid = current.sid;
  let id: number;
  if (typeof ref === "number") id = ref;
  else {
    const m = ref.trim().match(/^@s(\d+)e(-?\d+)$/);
    if (!m) throw new RefError("STALE_REF", `"${ref.slice(0, 20)}" isn't a control reference.`);
    sid = Number(m[1]);
    id = Number(m[2]);
  }
  if (sid !== current.sid) throw new RefError("STALE_REF", "That control came from an older look at the window.");
  const e = current.elements.find((x) => x.id === id);
  if (!e) throw new RefError("STALE_REF", "That control isn't on the window any more.");
  return e;
}

/**
 * Is `now` (what's under the point, or a fresh read) the same control as `chosen`? Role, name
 * and AutomationId must agree, and the rectangle may drift only `tolerance` pixels. A vision
 * point (2×2) has no rectangle worth comparing.
 */
export function sameTarget(chosen: UiElement, now: UiElement | null, tolerance = 6): boolean {
  if (!now) return false;
  if (chosen.type !== "Point" && now.type !== chosen.type) return false;
  if ((now.name || "").trim() !== (chosen.name || "").trim()) return false;
  if (chosen.aid && now.aid && now.aid !== chosen.aid) return false;
  if (chosen.w <= 2 && chosen.h <= 2) return true;
  return Math.abs(now.x - chosen.x) <= tolerance && Math.abs(now.y - chosen.y) <= tolerance && Math.abs(now.w - chosen.w) <= tolerance && Math.abs(now.h - chosen.h) <= tolerance;
}

/** The question back for AMBIGUOUS_TARGET: "Which one: "Save" (Button) or "Save" (MenuItem)?" */
export function whichOne(options: UiElement[]) {
  const names = options.slice(0, 3).map((e) => `"${(labelOf(e) || e.type).slice(0, 30)}"${options.filter((o) => labelOf(o) === labelOf(e)).length > 1 ? ` (${e.type})` : ""}`);
  return `I can see more than one that fits: ${names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]}. Which one?`;
}
