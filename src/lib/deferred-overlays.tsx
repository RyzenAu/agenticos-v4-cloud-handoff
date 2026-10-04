// Heavy overlays that the shell mounts on every page but nobody sees at first paint.
//
// The chat/voice dock (FloatingOracle → VoiceCompanion, wake word, chat input, oracle visuals) and
// the accounts hub (ConnectionsPanel → audience charts → recharts) were static imports of
// __root.tsx, so every route downloaded, transformed and hydrated ~3 MB of their modules before the
// page became interactive. They now load after first paint (browser idle, capped), or at once when
// one of their trigger events fires. Trigger events that arrive before they have mounted are
// captured and replayed right after mount, so "Chat", "Voice", "Connect account" and the /chat
// host still work from the very first click. Server render and hydration never include them.
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";

type Queued = { type: string; detail: unknown };

function RunAfterMount({ run }: { run: () => void }) {
  // Sibling after the lazy overlay inside one Suspense boundary: its effect runs after every
  // effect in the overlay's subtree, i.e. once the overlay's own listeners are attached.
  useEffect(run, [run]);
  return null;
}

export function deferredOverlay<P extends object>(
  load: () => Promise<ComponentType<P>>,
  triggers: readonly string[],
  idleTimeoutMs = 2000,
) {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  return function DeferredOverlay(props: P) {
    const [show, setShow] = useState(false);
    const queue = useRef<Queued[]>([]);
    const capturing = useRef(true);
    useEffect(() => {
      const capture = (event: Event) => {
        if (!capturing.current) return;
        queue.current.push({ type: event.type, detail: (event as CustomEvent).detail });
        setShow(true);
      };
      for (const type of triggers) window.addEventListener(type, capture);
      const idle = typeof window.requestIdleCallback === "function";
      const handle = idle
        ? window.requestIdleCallback(() => setShow(true), { timeout: idleTimeoutMs })
        : window.setTimeout(() => setShow(true), 300);
      return () => {
        for (const type of triggers) window.removeEventListener(type, capture);
        if (idle) window.cancelIdleCallback(handle);
        else window.clearTimeout(handle);
      };
    }, []);
    const replay = useRef(() => {
      capturing.current = false;
      for (const event of queue.current.splice(0)) window.dispatchEvent(new CustomEvent(event.type, { detail: event.detail }));
    }).current;
    if (!show) return null;
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
        <RunAfterMount run={replay} />
      </Suspense>
    );
  };
}

/** Chat + voice dock. Triggers: every event that opens it or hands it a job. */
export const FloatingOracle = deferredOverlay(
  () => import("@/components/floating-oracle").then((m) => m.FloatingOracle),
  [
    "operator:ask",
    "oracle:activate",
    "brain:open",
    "memory:source-preview",
    "argentic:chat-host",
    "operator:voice",
    "operator:voice-text",
    "operator:voice-wake",
    "jarvis:meeting",
  ],
);

/** Connect-an-account modal, opened only by the `agentic:accounts` event. */
export const AccountsHub = deferredOverlay(
  () => import("@/components/operator/accounts-hub").then((m) => m.AccountsHub),
  ["agentic:accounts"],
  4000,
);
