import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { HYDRATION_GUARD_SCRIPT, installHydrationClickGuard, type GuardApi } from "../src/lib/hydration-click-guard";

// A server-rendered page before React hydrates: buttons exist but have no React props yet.
function page(path = "/today") {
  const { window } = parseHTML(
    `<html><head></head><body>
      <header>
        <button type="button" id="inspector-toggle"><svg><path></path></svg>Inspector</button>
        <button type="button" aria-label="Talk to Jarvis">Jarvis</button>
        <button type="button" disabled id="off">Off</button>
        <a href="/leads" id="link">Leads</a>
        <div role="button" tabindex="0" id="rb">Refresh</div>
      </header>
      <form id="f"><button id="retry">Retry</button></form>
      <button type="button" id="approve">Approve</button>
      <button type="button" id="plain-danger" data-consequential>Go</button>
    </body></html>`,
  );
  const location = { pathname: path };
  class KeyboardEvent extends window.Event {
    key: string;
    constructor(type: string, init: { key?: string; bubbles?: boolean; cancelable?: boolean } = {}) {
      super(type, init);
      this.key = init.key ?? "";
    }
  }
  const win = {
    document: window.document,
    location,
    KeyboardEvent,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
  } as unknown as Window & typeof globalThis;
  const doc = window.document;
  const $ = (sel: string) => doc.querySelector(sel) as unknown as HTMLElement;
  // What React does: listen on the root (document), then attach props to each node it hydrates.
  const reactListens = () => ((doc as unknown as Record<string, unknown>)["_reactListeningx1"] = true);
  const hydrate = (el: Element) => ((el as unknown as Record<string, unknown>)["__reactProps$x1"] = {});
  const click = (el: Element) => {
    const ev = new window.Event("click", { bubbles: true, cancelable: true }) as Event & { button: number };
    ev.button = 0;
    el.dispatchEvent(ev);
    return ev;
  };
  const key = (el: Element, k: string) => {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(ev as unknown as Event);
    return ev as unknown as Event;
  };
  // Count the clicks "React" would handle: only once the node is hydrated.
  const handled: string[] = [];
  doc.addEventListener("click", (e: Event) => {
    const el = (e.target as Element).closest("button,[role=button]");
    if (el && Object.keys(el).some((k) => k.startsWith("__reactProps$"))) handled.push(el.id || el.getAttribute("aria-label") || "");
  });
  doc.addEventListener("keydown", (e: Event) => {
    const el = e.target as Element;
    if (Object.keys(el).some((k) => k.startsWith("__reactProps$"))) handled.push(`key:${el.id}:${(e as unknown as { key: string }).key}`);
  });
  return { window, win, doc, location, $, reactListens, hydrate, click, key, handled };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test("classify: unhydrated buttons are queued; links, disabled and hydrated controls are left alone", () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  expect(guard.classify(p.$("#inspector-toggle path")).action).toBe("queue");
  expect(guard.classify(p.$("#inspector-toggle path")).el).toBe(p.$("#inspector-toggle"));
  expect(guard.classify(p.$("#rb")).action).toBe("queue");
  expect(guard.classify(p.$("#link")).action).toBe("ignore");
  expect(guard.classify(p.$("#off")).action).toBe("ignore");
  expect(guard.classify(p.$("header")).action).toBe("ignore");
  p.hydrate(p.$("#retry"));
  expect(guard.classify(p.$("#retry")).action).toBe("ignore");
  guard.dispose();
});

test("a click before hydration is kept, not lost, and replayed exactly once after hydration", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  const first = p.click(p.$("#inspector-toggle path"));
  p.click(p.$("#inspector-toggle")); // an impatient second click is the same intent
  expect(first.defaultPrevented).toBe(true);
  expect(guard.queue.length).toBe(1);
  expect(p.doc.documentElement.hasAttribute("data-hydration-pending")).toBe(true);
  expect(p.$("#inspector-toggle").hasAttribute("data-hydration-pending")).toBe(false); // no hydration mismatch
  expect(p.handled).toEqual([]);

  p.reactListens();
  p.hydrate(p.$("#inspector-toggle"));
  guard.hydrated();
  guard.hydrated(); // a second call is harmless
  await tick();
  expect(p.handled).toEqual(["inspector-toggle"]);
  expect(guard.replayed).toBe(1);
  expect(guard.state).toBe("idle");
  expect(p.doc.documentElement.hasAttribute("data-hydration-pending")).toBe(false);
});

test("a native form submit is prevented before hydration and the button replays after", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  expect(p.click(p.$("#retry")).defaultPrevented).toBe(true);
  p.reactListens();
  p.hydrate(p.$("#retry"));
  guard.hydrated();
  await tick();
  expect(p.handled).toEqual(["retry"]);
});

test("once React is listening, the guard stays out of the way: no queue, no double fire", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.reactListens(); // hydrateRoot has run; React hydrates the target itself on click
  const ev = p.click(p.$("#inspector-toggle"));
  expect(ev.defaultPrevented).toBe(false);
  expect(guard.queue.length).toBe(0);
  p.hydrate(p.$("#inspector-toggle"));
  guard.hydrated();
  await tick();
  expect(guard.replayed).toBe(0);
});

test("a click React already handled is never replayed", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.hydrate(p.$("#retry"));
  p.click(p.$("#retry"));
  expect(guard.queue.length).toBe(0);
  expect(p.handled).toEqual(["retry"]);
  p.reactListens();
  guard.hydrated();
  await tick();
  expect(p.handled).toEqual(["retry"]);
});

test("links keep native navigation and are never queued", () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  expect(p.click(p.$("#link")).defaultPrevented).toBe(false);
  expect(guard.queue.length).toBe(0);
  guard.dispose();
});

test("no replay after navigation: a click queued on another path is dropped", async () => {
  const p = page("/today");
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#inspector-toggle"));
  p.location.pathname = "/leads";
  p.reactListens();
  p.hydrate(p.$("#inspector-toggle"));
  guard.hydrated();
  await tick();
  expect(p.handled).toEqual([]);
  expect(guard.replayed).toBe(0);
  expect(guard.state).toBe("idle");
});

test("shouldReplay: wait while unhydrated, replay once hydrated, drop when stale, moved or gone", () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  const el = p.$("#inspector-toggle");
  const item = { el, kind: "click" as const, path: "/today", at: 1000, id: el.id, tag: "BUTTON", label: "Inspector" };
  expect(guard.shouldReplay(item, "/today", 1100)).toBe("wait");
  p.hydrate(el);
  expect(guard.shouldReplay(item, "/today", 1100)).toBe("replay");
  expect(guard.shouldReplay(item, "/leads", 1100)).toBe("drop");
  expect(guard.shouldReplay(item, "/today", 1000 + 60_000)).toBe("drop");
  el.remove();
  expect(guard.shouldReplay({ ...item, id: "" , label: "nothing like it" }, "/today", 1100)).toBe("drop");
  guard.dispose();
});

test("a control React re-rendered during hydration is found again by id", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#inspector-toggle"));
  const old = p.$("#inspector-toggle");
  const fresh = p.doc.createElement("button");
  fresh.id = "inspector-toggle";
  old.replaceWith(fresh);
  p.reactListens();
  p.hydrate(fresh);
  guard.hydrated();
  await tick();
  expect(p.handled).toEqual(["inspector-toggle"]);
});

test("a control still unhydrated when the root commits is retried, then replayed once", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#retry"));
  p.reactListens();
  guard.hydrated();
  await tick(60);
  expect(p.handled).toEqual([]);
  expect(guard.state).toBe("replaying");
  p.hydrate(p.$("#retry"));
  await tick(120);
  expect(p.handled).toEqual(["retry"]);
  expect(guard.replayed).toBe(1);
});

test("a control disabled when hydration lands (Refresh during the first load) waits until it is enabled", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#retry"));
  p.reactListens();
  p.hydrate(p.$("#retry"));
  (p.$("#retry") as HTMLButtonElement).disabled = true;
  const item = guard.queue[0];
  expect(guard.shouldReplay(item, "/today", item.at)).toBe("wait");
  guard.hydrated();
  await tick(120);
  expect(p.handled).toEqual([]);
  (p.$("#retry") as HTMLButtonElement).disabled = false;
  await tick(120);
  expect(p.handled).toEqual(["retry"]);
  expect(guard.replayed).toBe(1);
});

test("Enter on a role=button element is replayed as the same key; native buttons rely on click", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  expect(p.key(p.$("#rb"), "Enter").defaultPrevented).toBe(true);
  expect(p.key(p.$("#inspector-toggle"), "Enter").defaultPrevented).toBe(false);
  expect(p.key(p.$("#rb"), "a").defaultPrevented).toBe(false);
  expect(guard.queue.map((q) => q.kind)).toEqual(["key"]);
  p.reactListens();
  p.hydrate(p.$("#rb"));
  guard.hydrated();
  await tick();
  expect(p.handled).toEqual(["key:rb:Enter"]);
});

test("after hydration the guard is idle: later clicks pass straight through", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.reactListens();
  guard.hydrated();
  await tick();
  delete (p.doc as unknown as Record<string, unknown>)["_reactListeningx1"]; // even if the marker vanished
  expect(p.click(p.$("#inspector-toggle")).defaultPrevented).toBe(false);
  expect(guard.queue.length).toBe(0);
});

test("pagehide retires the guard without replaying", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#inspector-toggle"));
  p.window.dispatchEvent(new p.window.Event("pagehide"));
  expect(guard.state).toBe("idle");
  expect(guard.queue.length).toBe(0);
  p.reactListens();
  p.hydrate(p.$("#inspector-toggle"));
  guard.hydrated();
  await tick();
  expect(p.handled).toEqual([]);
});

test("the inline script is self-contained: evaluated on its own it installs one guard", () => {
  const p = page();
  const w = p.win as unknown as Record<string, GuardApi | undefined>;
  new Function("window", HYDRATION_GUARD_SCRIPT)(p.win);
  const guard = w.__agenticHydrationGuard;
  expect(guard?.state).toBe("listening");
  new Function("window", HYDRATION_GUARD_SCRIPT)(p.win);
  expect(w.__agenticHydrationGuard).toBe(guard);
  p.click(p.$("#inspector-toggle"));
  expect(guard?.queue.length).toBe(1);
  guard?.dispose();
});

// ── Merge review U2: never twice ─────────────────────────────────────────────────────────────
test("U2: queued before React listens, clicked again once live: React's click runs, the queued one is dropped", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#retry")); // queued: nothing visible happens yet
  expect(guard.queue.length).toBe(1);
  p.reactListens(); // hydrateRoot started
  p.hydrate(p.$("#retry"));
  const again = p.click(p.$("#retry")); // the user clicks again; React handles this one
  expect(again.defaultPrevented).toBe(false);
  expect(p.handled).toEqual(["retry"]);
  expect(guard.queue.length).toBe(0);
  guard.hydrated(); // root commit: nothing left to replay
  await tick();
  expect(p.handled).toEqual(["retry"]);
  expect(guard.replayed).toBe(0);
  expect(guard.state).toBe("idle");
});

test("U2: a real click during the replay window drops the queued click (at most one action)", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#inspector-toggle"));
  p.reactListens();
  guard.hydrated(); // control not hydrated yet: the guard waits for it
  expect(guard.state).toBe("replaying");
  p.hydrate(p.$("#inspector-toggle"));
  p.click(p.$("#inspector-toggle")); // the user's own click, React handles it
  await tick(200);
  expect(p.handled).toEqual(["inspector-toggle"]);
  expect(guard.replayed).toBe(0);
  expect(guard.state).toBe("idle");
});

test("R1: clicked again while React listens but hasn't hydrated that control: kept from React, the queued click replays once", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  // Anything React's own document listener would see (registered after the guard, as in the page).
  const reactSaw: string[] = [];
  p.doc.addEventListener("click", (e: Event) => reactSaw.push(((e.target as Element).closest("button") as Element | null)?.id ?? ""), true);
  p.click(p.$("#inspector-toggle")); // queued before React listens
  expect(guard.queue.length).toBe(1);
  p.reactListens(); // hydrateRoot started; this control isn't hydrated yet
  reactSaw.length = 0;
  const again = p.click(p.$("#inspector-toggle"));
  expect(again.defaultPrevented).toBe(true);
  expect(reactSaw).toEqual([]); // React never saw half of it
  expect(guard.queue.length).toBe(1); // the first click is still owed (before R1 it was dropped: zero actions)
  expect(p.handled).toEqual([]);
  p.hydrate(p.$("#inspector-toggle"));
  guard.hydrated();
  await tick(200);
  expect(p.handled).toEqual(["inspector-toggle"]); // exactly once
  expect(guard.replayed).toBe(1);
  expect(guard.state).toBe("idle");
});

test("R1: the same race during the replay window (root committed, control still unhydrated) also runs once", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  p.click(p.$("#retry"));
  p.reactListens();
  guard.hydrated(); // the root committed, but #retry isn't hydrated yet: the guard waits for it
  expect(guard.state).toBe("replaying");
  p.click(p.$("#retry")); // unhydrated: React wouldn't run it, so it's the same intent
  expect(guard.queue.length).toBe(1);
  p.hydrate(p.$("#retry"));
  await tick(250);
  expect(p.handled).toEqual(["retry"]);
  expect(guard.replayed).toBe(1);
  expect(guard.state).toBe("idle");
});

test("U2: consequential buttons (Approve, data-consequential) are held and announced, never replayed", async () => {
  const p = page();
  const guard = installHydrationClickGuard(p.win);
  expect(guard.classify(p.$("#approve")).action).toBe("block");
  expect(guard.classify(p.$("#plain-danger")).action).toBe("block");
  const ev = p.click(p.$("#approve"));
  expect(ev.defaultPrevented).toBe(true);
  expect(guard.queue.length).toBe(0);
  expect(guard.blocked).toBe(1);
  expect(p.doc.documentElement.getAttribute("data-hydration-blocked")).toBe("Approve");
  p.reactListens();
  p.hydrate(p.$("#approve"));
  guard.hydrated();
  await tick();
  expect(p.handled).toEqual([]); // not replayed: the owner presses it again on the live page
  expect(p.doc.documentElement.hasAttribute("data-hydration-blocked")).toBe(false);
  p.click(p.$("#approve"));
  expect(p.handled).toEqual(["approve"]);
});
