import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { NEEDS_CONFIRM_LINE } from "@/lib/needs-confirm";
import { PAIRING_LINK } from "./pairing-notice";
import { useBrowserPending } from "./signed-in";

/** The one calm line for a read the hub refused because this browser isn't confirmed. No retry button: retrying cannot help. */
export function NeedsConfirmNote({ className = "", unlessBanner = false }: { className?: string; /** Say nothing while the shell's own "isn't confirmed yet" banner is showing: one message, not two. */ unlessBanner?: boolean }) {
  const bannerShowing = useBrowserPending();
  if (unlessBanner && bannerShowing) return null;
  return (
    <p role="status" data-needs-confirm="" className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground ${className}`.trim()}>
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0 text-warn" />
      <span>{NEEDS_CONFIRM_LINE}</span>
      <Link {...PAIRING_LINK} className="font-medium text-foreground underline underline-offset-4">Confirm this browser</Link>
    </p>
  );
}
