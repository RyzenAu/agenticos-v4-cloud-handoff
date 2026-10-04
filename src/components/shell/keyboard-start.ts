import { useEffect } from "react";

/**
 * A page that focuses a text box by itself as it loads (the chat composer on Chat, the one inside Calendar) made the first Tab land on
 * "Select model" instead of the skip link (acceptance finding H-10). For the first seconds after a load, and only until the person has
 * pressed a key or clicked, a text field that takes focus in the main area is let go and keyboard navigation restarts from the top of the
 * page, so the first Tab is the skip link. A person who types or clicks first is never touched.
 */
export function useKeyboardStart(windowMs = 4000) {
  useEffect(() => {
    let touched = false;
    const touch = () => { touched = true; };
    const onFocusIn = (event: FocusEvent) => {
      if (touched) return;
      const el = event.target;
      if (!(el instanceof HTMLElement) || !el.closest("#op-main-content, .ws-fullscreen-route")) return;
      if (!el.matches("textarea, input, [contenteditable=''], [contenteditable='true']")) return;
      el.blur();
      // Move the "where Tab starts from" point to the top of the page: a focused, then removed, marker just before the first control.
      const marker = document.createElement("span");
      marker.tabIndex = -1;
      marker.setAttribute("aria-hidden", "true");
      document.body.prepend(marker);
      marker.focus({ preventScroll: true });
      marker.remove();
    };
    document.addEventListener("keydown", touch, true);
    document.addEventListener("pointerdown", touch, true);
    document.addEventListener("focusin", onFocusIn, true);
    const timer = window.setTimeout(() => {
      document.removeEventListener("focusin", onFocusIn, true);
    }, windowMs);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", touch, true);
      document.removeEventListener("pointerdown", touch, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [windowMs]);
}
