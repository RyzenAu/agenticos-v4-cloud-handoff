import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { DOT_REFUSAL_EVENT, dotRefusals, isDotGatewayUi, NOT_AVAILABLE_PREFIX } from "@/lib/dot-gateway";

/**
 * In the gateway's UI bundle only: one plain line at the top of the page saying what on this page is the founders' and so
 * not shown to Dot. The panels themselves show their usual error state with the same reason.
 */
export function DotGatewayNotice() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [reasons, setReasons] = useState<string[]>([]);
  useEffect(() => {
    if (!isDotGatewayUi()) return;
    const refresh = () => setReasons(dotRefusals(window.location.pathname));
    refresh();
    window.addEventListener(DOT_REFUSAL_EVENT, refresh);
    return () => window.removeEventListener(DOT_REFUSAL_EVENT, refresh);
  }, [pathname]);
  if (!isDotGatewayUi()) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground" data-testid="dot-gateway-notice">
      Signed in as Dot through the gateway.
      {reasons.length ? (
        <details className="mt-1">
          <summary className="cursor-pointer">
            {NOT_AVAILABLE_PREFIX}: {reasons.length === 1 ? "one part of this page" : `${reasons.length} parts of this page`} (the founders' own)
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5" data-testid="dot-not-available">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default DotGatewayNotice;
