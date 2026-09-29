// Mount points for components other tracks build. The shell finds them by file convention, so a
// track merges its component and it appears — no edit to the sidebar, __root or the route files.
//
//   Area          File the track exports (default export, a React component)   Mounted at
//   receptionist  src/components/receptionist/destination.tsx                  /receptionist (replaces the current page)
//   finance       src/components/finance/destination.tsx                       /finance
//   memory        src/components/memory/destination.tsx                        /memory/vault
//   devices       src/components/profile/destination.tsx                       /system (Devices and people)
//
// Each receives `MountProps`. Until the file exists the page shows its honest fallback. A mounted
// component that throws is contained here: the rest of the page keeps working.
import { Component, Suspense, lazy, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Notice, Skeleton } from "@/components/ds";

export type MountArea = "receptionist" | "finance" | "memory" | "devices";

/** What the shell hands every mounted destination component. */
export type MountProps = {
  /** Publish technical detail (logs, timings, confidence) to the Inspector instead of the page. */
  inspect: (entry: { title: string; detail?: string; confidence?: number; tone?: "neutral" | "warn" | "danger" }) => void;
};

type MountModule = { default: ComponentType<MountProps> };

const MODULES: Record<MountArea, Record<string, () => Promise<MountModule>>> = {
  receptionist: import.meta.glob<MountModule>("../receptionist/destination.tsx"),
  finance: import.meta.glob<MountModule>("../finance/destination.tsx"),
  memory: import.meta.glob<MountModule>("../memory/destination.tsx"),
  devices: import.meta.glob<MountModule>("../profile/destination.tsx"),
};

export const MOUNT_FILES: Record<MountArea, { file: string; track: string }> = {
  receptionist: { file: "src/components/receptionist/destination.tsx", track: "rx-dash" },
  finance: { file: "src/components/finance/destination.tsx", track: "finance" },
  memory: { file: "src/components/memory/destination.tsx", track: "memory" },
  devices: { file: "src/components/profile/destination.tsx", track: "devices" },
};

/**
 * Start fetching a mounted component's chunk as soon as its page module loads, instead of after
 * hydration (DestinationMount only renders on the client). Without this the destination's own
 * heading waited for hydration + a lazy-chunk waterfall (/receptionist: ~1.6 s vs ~0.35 s).
 * React.lazy reuses the same import() promise, so nothing loads twice.
 */
export function preloadMount(area: MountArea) {
  if (typeof window === "undefined") return;
  const loader = Object.values(MODULES[area])[0];
  if (loader) void loader().catch(() => undefined);
}

/** True when the track's component is part of this build. */
export function hasMount(area: MountArea) {
  return Object.keys(MODULES[area]).length > 0;
}

/** Contains a mounted component that throws, so the rest of the page keeps working. */
export class MountBoundary extends Component<{ area: MountArea; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <Notice tone="danger" title="This section failed to load">
          {this.state.error.message || "The component threw while rendering."} The rest of the page is unaffected.
        </Notice>
      );
    return this.props.children;
  }
}

/** Renders the track's component when it exists (client only), otherwise `fallback`. */
export function DestinationMount({ area, fallback, inspect }: { area: MountArea; fallback: ReactNode; inspect: MountProps["inspect"] }) {
  const loader = Object.values(MODULES[area])[0];
  const Lazy = useMemo(() => (loader ? lazy(loader) : null), [loader]);
  const [client, setClient] = useState(false);
  useEffect(() => setClient(true), []);
  if (!Lazy) return <>{fallback}</>;
  if (!client) return <Skeleton className="h-48 rounded-xl" />;
  return (
    <MountBoundary area={area}>
      <Suspense fallback={<Skeleton className="h-48 rounded-xl" />}>
        <Lazy inspect={inspect} />
      </Suspense>
    </MountBoundary>
  );
}
