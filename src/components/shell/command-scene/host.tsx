// Opens the optional Command scene: `openCommandScene()`, the `command-scene:open` event, or `?scene=1` on
// any page (what the command palette and Jarvis use). The scene's code loads only on the first open.
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Orbit } from "lucide-react";
import { sceneOpener, sceneReturnTarget } from "./focus-return";

const Scene = lazy(() => import("./command-scene"));
const OPEN = "command-scene:open";

export function openCommandScene() {
  window.dispatchEvent(new Event(OPEN));
}

export function CommandSceneHost() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // What had focus when it opened: Escape (or any close) returns focus there (REVIEW-T1 R2).
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useCallback(() => sceneReturnTarget(opener.current, document), []);
  const router = useRouter();
  const wanted = useRouterState({ select: (s) => String((s.location.search as Record<string, unknown>).scene ?? "") });
  useEffect(() => {
    const onOpen = () => {
      opener.current = sceneOpener(document.activeElement);
      setLoaded(true);
      setOpen(true);
    };
    window.addEventListener(OPEN, onOpen);
    return () => window.removeEventListener(OPEN, onOpen);
  }, []);
  useEffect(() => {
    if (wanted !== "1") return;
    opener.current = sceneOpener(document.activeElement);
    setLoaded(true);
    setOpen(true);
    // Drop the parameter so Back and a refresh don't reopen it.
    const loc = router.state.location;
    const { scene: _scene, ...rest } = loc.search as Record<string, unknown>;
    void router.navigate({ to: loc.pathname as never, search: rest as never, replace: true });
  }, [wanted, router]);
  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <Scene open={open} onOpenChange={setOpen} returnFocus={returnFocus} />
    </Suspense>
  );
}

/** The quiet way in, for page headers. */
export function CommandSceneButton({ className = "" }: { className?: string } = {}) {
  return (
    <button
      type="button"
      className={`op-header-ask items-center gap-1.5 ${className || "inline-flex"}`}
      data-command-scene-trigger=""
      onClick={openCommandScene}
      onPointerEnter={() => void import("./command-scene").catch(() => undefined)}
      title="The Command scene: a spatial overview of Receptionist, Leads, Coding, Memory and Finance (optional)"
    >
      <Orbit className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Command scene</span>
    </button>
  );
}
