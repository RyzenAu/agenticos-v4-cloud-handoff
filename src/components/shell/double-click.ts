/** Opening a destination moves the rows under the pointer (its sub-list opens, the previous one closes), so the second click of a double-click
 *  used to land on a different link (audit S2). That second click is ignored.
 *
 *  Round 8: only the second click OF A DOUBLE-CLICK is ignored, as the browser counts it (`event.detail` 2 or more: same place, quick succession).
 *  A deliberate click on another link soon after arriving (detail 1), or a link opened from the keyboard (detail 0), always goes through. The time
 *  alone used to decide, so a person who clicked Automations and then Memory within 450 ms got nothing (routes sweep, candidate 3bc6f9e0). */
export const DOUBLE_CLICK_MS = 450;

export function guardDoubleClick(
  event: { target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void; detail?: number },
  last: { current: number },
  now = Date.now(),
): boolean {
  const link = (event.target as Element | null)?.closest?.("a");
  if (!link) return false;
  if ((event.detail ?? 0) >= 2 && now - last.current < DOUBLE_CLICK_MS) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  last.current = now;
  return false;
}
