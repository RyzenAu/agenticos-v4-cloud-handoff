// Mount point for the Finance destination (src/components/shell/mounts.tsx). The finance track's
// NAB CSV import and owner-scoped aggregates, embedded under the shell page's own header and tiles.
import type { MountProps } from "@/components/shell/mounts";
import { FinanceDestination } from "@/components/finance/manual-finance";

export default function FinanceDestinationMount(_props: MountProps) {
  return <FinanceDestination embedded />;
}
