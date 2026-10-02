// /memory/vault: the memory track's curated vault — search, sources ("facts used"), corrections
// and forgetting in the shared business pool. Mounted from src/components/memory/destination.tsx.
import { Link } from "@tanstack/react-router";
import { BookMarked } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ds";
import { useInspector, useInspectorFacts } from "../inspector";
import { DestinationMount, MOUNT_FILES, hasMount, preloadMount } from "../mounts";
import { DrilldownList } from "../page-parts";

preloadMount("memory");

export function VaultPage() {
  const { publish } = useInspector();
  useInspectorFacts("Mount points", {
    Vault: hasMount("memory") ? `mounted from ${MOUNT_FILES.memory.file}` : `placeholder; waiting for ${MOUNT_FILES.memory.file} (${MOUNT_FILES.memory.track} track)`,
  });
  return (
    <div className="min-w-0 max-w-[1320px]">
      <DestinationMount
        area="memory"
        inspect={publish}
        fallback={
          <>
            <PageHeader
              title="Vault"
              description="Shared business memory: search, sources and corrections."
            />
            <EmptyState
              icon={BookMarked}
              title="The curated vault isn't in this build yet"
              body="Search with sources, corrections and forgetting arrive with the memory track. Until then, Memory holds captured notes and the memory map shows where each kind of memory lives."
              action={
                <Link to="/memory" className="text-sm font-medium text-foreground underline underline-offset-2">
                  Open Memory
                </Link>
              }
            />
          </>
        }
      />
      <div className="mt-12">
        <DrilldownList id="memory" />
      </div>
    </div>
  );
}
