// Hydration click guard: a click on a server-rendered button before React has hydrated used to be
// lost silently (no handler yet — 350–620 ms on a cold load). This guard catches it and replays it
// once, on the same element, after hydration.
//
// The installer runs as an inline <head> script, so it is self-contained: it is serialised with
// Function#toString and must not reference anything outside itself.
//   · Until React attaches its root listeners (the `_reactListening…` key on document), a click on
//     a button-like control React has not hydrated (no `__reactProps$…` key) is queued and its
//     default action (e.g. a native form submit) is prevented. <html> gets `data-hydration-pending`
//     and a progress cursor so the click reads as "working". Controls themselves are not touched:
//     an attribute on them would be a hydration mismatch.
//   · Links are left alone: native link navigation already works before hydration.
//   · Once React is listening it handles clicks itself (it hydrates the target synchronously, then
//     dispatches), so the guard stops intercepting — a click React handles is never queued.
//   · `hydrated()` (from the root component's first effect) replays each queued control once —
//     repeat clicks on one control before hydration are one intent — only while the page is still
//     on the path it was clicked on, then removes its listeners and goes idle. A control that is
//     still unhydrated, or hydrated but disabled (a Refresh during the first load), is retried for
//     up to 3 s; then an enabled one is clicked anyway (React hydrates on click).
//   · Never twice (merge review U2): once a queued control is hydrated, a real click on it means the
//     user acted again and React handled it, so the queued click is dropped, not replayed. The guard
//     keeps watching until its queue is empty.
//   · Never zero (merge review R1): a repeat click on a queued control React is listening for but
//     hasn't hydrated yet isn't handled by React, so it is swallowed (kept from React's listener)
//     and the queued click still replays once.
//   · Consequential controls (approve, send, pay, delete, merge, deploy, publish, confirm…, or any
//     control marked data-consequential) are never queued or replayed: the click is held, <html> gets
//     `data-hydration-blocked` (a "still loading, press it again" notice) until hydration, and the
//     owner presses it again on the live page.

export type GuardItem = {
  el: Element;
  kind: "click" | "key";
  key?: string;
  /** location.pathname when clicked: a different path means the user navigated. */
  path: string;
  at: number;
  /** How to find the control again if hydration replaced the node. */
  id: string;
  tag: string;
  label: string;
};

export type GuardVerdict = "replay" | "drop" | "wait";

/** Labels of controls whose action must never be replayed from a pre-hydration click. */
export const CONSEQUENTIAL_LABEL = /\b(approve|approval|send|pay|payment|delete|remove|merge|deploy|publish|confirm|sign[ -]?off|reject|purchase|buy|transfer|submit|dial|call now)\b/i;

export type GuardApi = {
  /** Replay queued controls and retire the guard. Safe to call more than once. */
  hydrated: () => void;
  /** Retire without replaying. */
  dispose: () => void;
  readonly queue: GuardItem[];
  readonly state: "listening" | "replaying" | "idle";
  /** Number of controls replayed so far (for tests and the browser proof). */
  readonly replayed: number;
  /** Pure: what the guard does with an event target. */
  classify: (target: EventTarget | null) => { action: "ignore" | "queue" | "block"; el: Element | null };
  /** Consequential clicks held (never replayed) so far. */
  readonly blocked: number;
  /** Pure: whether a queued item should be replayed now. */
  shouldReplay: (item: GuardItem, currentPath: string, now: number) => GuardVerdict;
  /** True once React has attached its root listeners. */
  reactListening: () => boolean;
};

export const HYDRATION_GUARD_GLOBAL = "__agenticHydrationGuard";

/** Installs the guard on `win` (idempotent). Self-contained on purpose — see the header. */
export function installHydrationClickGuard(win: Window & typeof globalThis): GuardApi {
  const slot = "__agenticHydrationGuard";
  const bag = win as unknown as Record<string, GuardApi | undefined>;
  const existing = bag[slot];
  if (existing) return existing;
  const doc = win.document;
  const CONTROL =
    'a[href],button,input[type="button"],input[type="submit"],input[type="reset"],[role="button"],[role="tab"],[role="menuitem"],[role="switch"],[role="option"]';
  const MAX_QUEUE = 8;
  const STALE_MS = 15000;
  const RETRY_MS = 3000;
  const CONSEQUENTIAL = /\b(approve|approval|send|pay|payment|delete|remove|merge|deploy|publish|confirm|sign[ -]?off|reject|purchase|buy|transfer|submit|dial|call now)\b/i;
  const queue: GuardItem[] = [];
  let state: GuardApi["state"] = "listening";
  let replayed = 0;
  let blocked = 0;
  let firing = false;

  const hasKey = (obj: object, prefix: string) => Object.keys(obj).some((k) => k.indexOf(prefix) === 0);
  const reactListening = () => hasKey(doc, "_reactListening");
  const isHydrated = (el: Element) => hasKey(el, "__reactProps$") || hasKey(el, "__reactFiber$");
  const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
  const labelOf = (el: Element) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);

  const controlOf = (target: EventTarget | null): Element | null => {
    let node = target as Element | null;
    if (node && typeof node.closest !== "function") node = (node as Node).parentElement;
    return node ? node.closest(CONTROL) : null;
  };
  const consequential = (el: Element) => el.hasAttribute("data-consequential") || CONSEQUENTIAL.test(labelOf(el)) || CONSEQUENTIAL.test(el.getAttribute("title") || "");

  function classify(target: EventTarget | null): { action: "ignore" | "queue" | "block"; el: Element | null } {
    const el = controlOf(target);
    if (!el) return { action: "ignore", el: null };
    if (el.tagName === "A") return { action: "ignore", el }; // native navigation already works
    if (isDisabled(el)) return { action: "ignore", el };
    if (isHydrated(el)) return { action: "ignore", el };
    if (consequential(el)) return { action: "block", el };
    return { action: "queue", el };
  }

  /** A consequential click before hydration: held and announced, never replayed. */
  function block(el: Element) {
    blocked++;
    const root = doc.documentElement;
    if (!root) return;
    root.setAttribute("data-hydration-blocked", labelOf(el).slice(0, 40) || "that button");
    root.style.cursor = "progress";
  }
  const queuedIndex = (el: Element) => queue.findIndex((q) => q.el === el || (!!q.id && q.id === el.id));

  // If hydration re-rendered the control (a mismatch), find its replacement: same id, else the one
  // element with the same tag and label. Ambiguous → none.
  function relocate(item: GuardItem): Element | null {
    if (item.el.isConnected) return item.el;
    if (item.id) return doc.getElementById(item.id);
    if (!item.label) return null;
    const hits = Array.prototype.filter.call(doc.getElementsByTagName(item.tag), (e: Element) => labelOf(e) === item.label) as Element[];
    return hits.length === 1 ? hits[0] : null;
  }

  function shouldReplay(item: GuardItem, currentPath: string, now: number): GuardVerdict {
    if (item.path !== currentPath) return "drop"; // navigated away: never replay onto another page
    if (now - item.at > STALE_MS) return "drop"; // too old to still be what the user meant
    const el = relocate(item);
    if (!el) return "drop";
    item.el = el;
    // Unhydrated, or hydrated but disabled for now (e.g. "Refresh" while the first load runs):
    // wait for it rather than clicking into nothing.
    return isHydrated(el) && !isDisabled(el) ? "replay" : "wait";
  }

  function setPending(on: boolean) {
    const root = doc.documentElement;
    if (!root) return;
    if (on) {
      root.setAttribute("data-hydration-pending", "");
      root.style.cursor = "progress";
    } else {
      if (root.hasAttribute("data-hydration-pending")) root.removeAttribute("data-hydration-pending");
      if (!root.hasAttribute("data-hydration-blocked")) root.style.cursor = "";
    }
  }

  function enqueue(el: Element, kind: GuardItem["kind"], key?: string) {
    if (queue.some((q) => q.el === el)) return; // one intent per control
    if (queue.length >= MAX_QUEUE) return;
    queue.push({ el, kind, key, path: win.location.pathname, at: Date.now(), id: el.id, tag: el.tagName, label: labelOf(el) });
    setPending(true);
  }

  /**
   * A repeat on a control that is already queued. While nothing can handle it yet it's the same
   * intent (swallowed): before React listens, and also once React listens but hasn't hydrated THIS
   * control — React doesn't run its handler then, so dropping the queued click lost both (merge
   * review R1: two clicks, nothing happened). It's stopped before React's own document listener
   * sees it, and the queued click replays once. Once the control is hydrated the user's own click
   * is React's, so the queued one is dropped and never replays (U2). Returns true when it dealt
   * with the event.
   */
  function repeat(event: Event): boolean {
    if (firing || !queue.length) return false;
    const el = controlOf(event.target);
    const i = el ? queuedIndex(el) : -1;
    if (i < 0 || !el) return false;
    if (!isHydrated(el)) {
      event.preventDefault();
      if (reactListening()) event.stopImmediatePropagation();
      return true;
    }
    queue.splice(i, 1);
    if (!queue.length && state === "replaying") finish();
    return true;
  }

  function onClick(event: MouseEvent) {
    if (event.button !== 0) return;
    if (repeat(event)) return;
    if (state !== "listening" || reactListening()) return;
    if (event.defaultPrevented) return;
    const c = classify(event.target);
    if (!c.el || c.action === "ignore") return;
    event.preventDefault();
    if (c.action === "block") block(c.el);
    else enqueue(c.el, "click");
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (repeat(event)) return;
    if (state !== "listening" || reactListening()) return;
    const c = classify(event.target);
    if (!c.el || c.action === "ignore") return;
    // Native buttons turn Enter/Space into a click, which onClick already catches.
    if (c.el.tagName === "BUTTON" || c.el.tagName === "INPUT") return;
    event.preventDefault();
    if (c.action === "block") block(c.el);
    else enqueue(c.el, "key", event.key);
  }

  function detach() {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKey, true);
    win.removeEventListener("pagehide", dispose);
  }

  function clearBlocked() {
    const root = doc.documentElement;
    if (root && root.hasAttribute("data-hydration-blocked")) {
      root.removeAttribute("data-hydration-blocked");
      if (!root.hasAttribute("data-hydration-pending")) root.style.cursor = "";
    }
  }

  function finish() {
    detach();
    queue.length = 0;
    setPending(false);
    state = "idle";
  }

  function dispose() {
    finish();
    clearBlocked();
  }

  function fire(item: GuardItem) {
    replayed++;
    firing = true;
    try {
      if (item.kind === "key") item.el.dispatchEvent(new win.KeyboardEvent("keydown", { key: item.key, bubbles: true, cancelable: true }));
      else (item.el as HTMLElement).click();
    } finally {
      firing = false;
    }
  }

  function drain(deadline: number) {
    const now = Date.now();
    const rest: GuardItem[] = [];
    for (const item of queue.splice(0)) {
      let verdict = shouldReplay(item, win.location.pathname, now);
      // Out of time: an enabled control is clicked anyway (React hydrates it on click); one that
      // is still disabled cannot act, so the click is dropped rather than faked.
      if (verdict === "wait" && now >= deadline) verdict = isDisabled(item.el) ? "drop" : "replay";
      if (verdict === "replay") fire(item);
      else if (verdict === "wait") rest.push(item);
    }
    queue.push(...rest);
    if (queue.length) setTimeout(() => (state === "replaying" && queue.length ? drain(deadline) : undefined), 50);
    else if (state === "replaying") finish();
  }

  function hydrated() {
    if (state !== "listening") return;
    // The page is live: a held consequential button can now be pressed again for real.
    clearBlocked();
    state = "replaying";
    // Listeners stay on until the queue is empty, so a real click on a queued control drops it.
    drain(Date.now() + RETRY_MS);
  }

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKey, true);
  win.addEventListener("pagehide", dispose);

  const api: GuardApi = {
    hydrated,
    dispose,
    get queue() {
      return queue;
    },
    get state() {
      return state;
    },
    get replayed() {
      return replayed;
    },
    get blocked() {
      return blocked;
    },
    classify,
    shouldReplay,
    reactListening,
  };
  bag[slot] = api;
  return api;
}

/** The inline <head> script: installs the guard before first paint. */
export const HYDRATION_GUARD_SCRIPT = `try{(${installHydrationClickGuard.toString()})(window)}catch(e){}`;

/** Called once from the root component's first effect, i.e. after hydration commits. */
export function markHydrated() {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, GuardApi | undefined>)[HYDRATION_GUARD_GLOBAL]?.hydrated();
}
