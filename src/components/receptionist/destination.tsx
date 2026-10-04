// Mount point for the Receptionist destination (src/components/shell/mounts.tsx finds this file by
// convention). The rx-dash track's dashboard, unchanged.
import type { MountProps } from "@/components/shell/mounts";
import { ReceptionistDashboardPage } from "@/components/receptionist/dashboard";

export default function ReceptionistDestinationMount(_props: MountProps) {
  return <ReceptionistDashboardPage />;
}
