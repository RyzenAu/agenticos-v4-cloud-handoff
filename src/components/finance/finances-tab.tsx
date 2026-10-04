// Finance → Finances (/business?view=finance) with real data (W-E, 29 Sep 2026). The owner saw
// "nothing" here because this tab only read the old Mercury snapshot (workspace.finances) and Stripe,
// both empty, and told him to "connect an account"; the NAB CSV ledger (finance-manual.sqlite, the one
// bank route) was only reachable from /finance. Now the tab shows that ledger first: its one-step
// import when nothing is imported, the cash flow and review once it is. No bank connection, no
// invented figures. The Mercury snapshot still shows when one was saved; Stripe stays read-only.
import type { BusinessWorkspace } from "@/lib/business-workspace";
import { EmptyState } from "@/components/ds";
import { Landmark } from "lucide-react";
import { StripeFinancePanel } from "@/components/business/stripe-finance-panel";
import { FinanceSnapshotState } from "@/components/business/finance-snapshot-state";
import { DestinationMount } from "@/components/shell/mounts";

const noInspector = () => undefined;

export function FinancesTab({ finances }: { finances?: BusinessWorkspace["finances"] }) {
  const mercury = (finances?.accounts?.length ?? 0) > 0;
  return (
    <div className="finances-tab min-w-0">
      <section className="mb-6" aria-label="Bank cash flow (NAB CSV)" data-finances-ledger>
        <DestinationMount
          area="finance"
          inspect={noInspector}
          fallback={
            <EmptyState variant="row" icon={Landmark} title="NAB CSV import isn't part of this build" body="The live bank feed is not connected (deferred by owner decision). No bank data is read." />
          }
        />
      </section>
      <StripeFinancePanel />
      {/* The older Mercury balance snapshot, only when one was actually saved (never "connect an account"). */}
      {mercury && <FinanceSnapshotState finances={finances} />}
    </div>
  );
}
