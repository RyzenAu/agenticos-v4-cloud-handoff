// /receptionist: the rx-dash track's dashboard (src/components/receptionist/destination.tsx).
// Imported directly (not through the lazy, client-only DestinationMount) so the page renders on the
// server with its heading: through the lazy mount the heading waited for hydration plus a chunk
// waterfall (~1.3-1.6 s first load vs ~0.35 s for the other destinations). The old receptionist
// page is no longer bundled here; it stays reachable as the fallback in git history.
import ReceptionistDashboardMount from "@/components/receptionist/destination";
import { useInspector, useInspectorFacts } from "../inspector";
import { MOUNT_FILES, MountBoundary } from "../mounts";
import { DrilldownList } from "../page-parts";

export function ReceptionistDestination() {
  const { publish } = useInspector();
  useInspectorFacts("Mount points", { Receptionist: `mounted from ${MOUNT_FILES.receptionist.file} (server-rendered)` });
  return (
    <>
      <MountBoundary area="receptionist">
        <ReceptionistDashboardMount inspect={publish} />
      </MountBoundary>
      <div className="mt-12">
        <DrilldownList id="receptionist" />
      </div>
    </>
  );
}
