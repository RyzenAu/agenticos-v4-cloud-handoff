import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useBrowserPending } from "./signed-in";

/** Where the confirm-code panel is: System › Devices and people, opened by the address (#system-devices). */
export const PAIRING_LINK = { to: "/system", hash: "system-devices" } as const;

/**
 * A browser opened at the PC cannot approve anything until it is confirmed with a code, and the panel for that lives on System, inside a
 * closed section. Until it is confirmed, every page says so at the top and links straight to the open panel (acceptance finding H-04).
 */
export function PairingNotice() {
  const pending = useBrowserPending();
  if (!pending) return null;
  return (
    <div role="status" className="sh-pairing-notice flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-foreground md:px-6">
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <span className="sm:hidden">Can't approve yet.</span>
        <span className="hidden sm:inline">This browser isn't confirmed yet, so it can't approve anything.</span>
      </span>
      <Link {...PAIRING_LINK} className="font-medium underline underline-offset-4">Confirm this browser</Link>
    </div>
  );
}
