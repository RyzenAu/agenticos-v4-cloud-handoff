// Ctrl/⌘K anywhere opens the ONE command palette. This host is tiny and always mounted; the palette
// itself (command-palette-body.tsx: cmdk, the registry, the economics model for answers) loads on the
// first open, so page load doesn't pay for it. `openCommandPalette(query?)` opens it from code; the old
// CRM palette's `crm-palette:open` event opens it too (CRM leads are one of its sources).
import { Suspense, lazy, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { PaletteLoadBoundary } from "./palette-boundary";
import "./experience.css";

const OPEN_EVENT = "command-palette:open";
const LEGACY_EVENT = "crm-palette:open";

const Body = lazy(() => import("./command-palette-body"));

export function openCommandPalette(query = "") {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { query } }));
}

/** Warm the palette chunk (and the app index) when the pointer or keyboard heads for the trigger. */
export function preloadCommandPalette() {
  void import("./command-palette-body").catch(() => undefined);
  void import("@/lib/commands/client").then((m) => m.loadApps()).catch(() => undefined);
}

export function CommandPaletteHost() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLoaded(true);
        setQuery("");
        setOpen((o) => !o);
      }
    };
    const onOpen = (e: Event) => {
      setLoaded(true);
      setQuery(String((e as CustomEvent<{ query?: string }>).detail?.query ?? ""));
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener(LEGACY_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener(LEGACY_EVENT, onOpen);
    };
  }, []);
  if (!loaded) return null;
  return (
    <PaletteLoadBoundary>
      <Suspense fallback={null}>
        <Body open={open} onOpenChange={setOpen} initialQuery={query} />
      </Suspense>
    </PaletteLoadBoundary>
  );
}

/** The header's visible way in (touch screens have no Ctrl+K). */
export function CommandPaletteButton() {
  return (
    <button
      type="button"
      className="cp-trigger"
      onClick={() => openCommandPalette()}
      onPointerEnter={preloadCommandPalette}
      onFocus={preloadCommandPalette}
      aria-label="Go to… (open the command palette)"
      aria-keyshortcuts="Control+K Meta+K"
      title="Open a page, project, site, file or app (Ctrl K)"
    >
      <Search className="h-4 w-4" aria-hidden="true" />
      <span className="hidden min-[1400px]:inline">Go to…</span>
      <kbd className="cp-kbd hidden min-[1400px]:inline-flex" aria-hidden="true">
        Ctrl K
      </kbd>
    </button>
  );
}
