// Renders FinanceTile specs (./signals.ts) with the shell's SignalTile. Links are optional so the
// row renders outside a router (tests); recovery actions are resolved by the caller.
import { SignalTile } from "@/components/shell/page-parts";
import type { FinanceRecovery, FinanceTile } from "./signals";

/** Where each finance tile's number comes from (shown on the tile with its last success). */
export const FINANCE_TILE_SOURCE: Record<string, string> = {
  "nab-csv": "NAB CSV import",
  "live-feed": "Basiq live bank feed",
  "ai-spend": "AI usage receipts and plan prices",
  "ai-month-end": "Projection from AI usage so far",
  "ai-unpriced": "AI usage receipts",
};

export function FinanceSignalRow({ tiles, now, onRecover, links = {}, className = "sh-signals mb-10" }: {
  tiles: FinanceTile[];
  now: number;
  onRecover: (action: FinanceRecovery, tileId: string) => void;
  links?: Partial<Record<string, string>>;
  className?: string;
}) {
  return (
    <div className={className} data-testid="finance-signals">
      {tiles.map((t) => (
        <div key={t.id} data-tile={t.id} data-state={t.loading ? "loading" : (t.state ?? "none")} className="grid min-w-0">
          <SignalTile
            label={t.label}
            value={t.value}
            hint={t.hint}
            tone={t.tone}
            state={t.state ?? (t.value === null ? "unknown" : undefined)}
            source={FINANCE_TILE_SOURCE[t.id]}
            loading={t.loading}
            to={links[t.id]}
            updatedAt={t.updatedAt === undefined ? undefined : t.updatedAt}
            now={t.updatedAt === undefined ? undefined : now}
            staleAfterMs={t.staleAfterMs}
            recovery={t.recovery ? { label: t.recovery.label, onClick: () => onRecover(t.recovery!.action, t.id) } : undefined}
          />
        </div>
      ))}
    </div>
  );
}
