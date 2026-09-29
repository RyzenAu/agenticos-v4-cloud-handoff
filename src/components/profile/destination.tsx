// Mount point for System › Devices and people (src/components/shell/mounts.tsx). The devices
// track's profile panel: paired devices, 30-day sessions and permissions.
import type { MountProps } from "@/components/shell/mounts";
import { ProfilePanel } from "@/components/profile/profile-panel";

export default function ProfileDestinationMount(_props: MountProps) {
  return <ProfilePanel />;
}
