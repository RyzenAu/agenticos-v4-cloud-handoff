import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import { pageName } from "./destinations";

/** A page that failed to load because its code could not be fetched (nothing to do with the page's own data). */
export function isChunkLoadError(error: unknown): boolean {
  const m = error instanceof Error ? error.message : String(error ?? "");
  return /dynamically imported module|importing a module script failed|failed to fetch|chunkloaderror|loading chunk|networkerror/i.test(m);
}

/** What the error screen says about a load failure: offline, a code-fetch failure while online, or null for anything else. */
export function loadFailureCopy(error: unknown, online: boolean): { title: string; body: string } | null {
  if (!online) return { title: "You're offline", body: "This page hasn't been opened since you lost the connection, so it can't load yet. Reconnect and try again; the pages you've already opened still work." };
  if (isChunkLoadError(error)) return { title: "This page couldn't load", body: "Its files didn't arrive. Check the connection (or that the hub is still running) and try again." };
  return null;
}

/** A route's code is in the browser once the route has been shown; its first path segment stands for it (workspaces/$id shares workspaces). */
export const routeKey = (pathname: string) => `/${pathname.split("/").filter(Boolean)[0] ?? ""}`;

/**
 * The connection state, said once at the top while it is down. A click on an in-app link while offline stays in the app: a page opened
 * before in this tab opens (its code is already here); one never opened says plainly that it can't load, instead of the browser's own error
 * page (TanStack's lazy route reloads the document when its code is missing) or a click that does nothing (acceptance finding H-09).
 */
export function OfflineNotice() {
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const [blocked, setBlocked] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    seen.current.add(routeKey(window.location.pathname));
    return router.subscribe("onResolved", () => seen.current.add(routeKey(window.location.pathname)));
  }, [router]);
  useEffect(() => {
    const sync = () => { setOnline(navigator.onLine); if (navigator.onLine) setBlocked(null); };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (navigator.onLine || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      if (seen.current.has(routeKey(url.pathname))) {
        setBlocked(null);
        router.history.push(`${url.pathname}${url.search}${url.hash}`);
      } else {
        setBlocked(pageName(url.pathname, new URLSearchParams(url.search).get("view")));
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);
  if (online) return null;
  return (
    <div role="status" className="sh-offline-notice flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-foreground md:px-6">
      <WifiOff size={16} aria-hidden="true" className="shrink-0 text-warn" />
      <span>
        {blocked
          ? `You're offline, and ${blocked} hasn't been opened in this tab yet, so it can't load. It will when you're back online.`
          : "You're offline. Pages you've already opened still work; others can't load until you're back."}
      </span>
    </div>
  );
}
