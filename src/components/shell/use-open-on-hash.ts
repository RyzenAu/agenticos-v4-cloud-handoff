import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";

/**
 * True once the address names `id` (#id), and it stays open after. The hash is read from the router: a router navigation, such as the
 * "Pair or confirm a browser" link on the page the section lives on, never fires a hashchange event (audit B2). `then` runs when it opens, so a
 * panel that opens on a hashchange event can be told once the section holding it is visible.
 */
export function useOpenOnHash(id: string, then?: () => void): [boolean, (open: boolean) => void] {
  const hash = useRouterState({ select: (s) => s.location.hash });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hash.replace(/^#/, "") !== id) return;
    setOpen(true);
    if (then) requestAnimationFrame(() => then());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, id]);
  return [open, setOpen];
}
