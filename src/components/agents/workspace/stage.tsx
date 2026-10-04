// The workspace body and, when a bot-list panel (New bot, Show archived) is open, that panel above it. The body is never unmounted for the panel:
// it is only hidden, so the conversation's draft, scroll position and live stream survive opening and closing it.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function WorkspaceStage({ panel, children }: { panel: ReactNode | null; children: ReactNode }) {
  return (
    <>
      {panel && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-6" data-testid="bot-panel">
          {panel}
        </div>
      )}
      <div className={cn("min-h-0 flex-1 flex-col gap-2 sm:gap-3", panel ? "hidden" : "flex")} data-testid="workspace-body" data-hidden={panel ? "true" : undefined}>
        {children}
      </div>
    </>
  );
}

/** Props that make a region inert (nothing in it takes focus or is read out) while `on`; nothing otherwise. */
export const inertProps = (on: boolean): Record<string, unknown> => (on ? { inert: true } : {});
