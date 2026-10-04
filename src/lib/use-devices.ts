// The device registry as the UI sees it (GET /__devices/devices, loopback/tailnet only). One slow read,
// paused while the tab is hidden; every field other than id is optional so an older hub still renders.
import { useQuery } from "@tanstack/react-query";
import { streamRefetchInterval, useStreamInvalidate } from "./use-activity";
import type { DeviceSlotInput } from "@/components/ds/motion-state";

export type DeviceRow = {
  id: string;
  label?: string;
  kind?: string;
  owner?: string;
  online?: boolean;
  mine?: boolean;
  primary?: boolean;
  busy?: boolean;
  displayLabel?: string;
  workerVersion?: string | null;
  capabilities?: string[] | null;
  interactive?: boolean | null;
  lastSeen?: number | null;
};

export async function readDevices(): Promise<DeviceRow[]> {
  const r = await fetch("/__devices/devices", { cache: "no-store" });
  if (!r.ok) throw new Error(`Devices ${r.status}`);
  const body = (await r.json()) as { devices?: DeviceRow[] };
  return Array.isArray(body.devices) ? body.devices : [];
}

export function useDevices() {
  // A device going online or offline arrives on the live stream (the hub samples presence every 2 s, so an offline
  // device shows within ~32 s of its last heartbeat); the timer is the safety net (60 s when there is no stream).
  useStreamInvalidate([["devices"]], ["device"], { debounceMs: 100 });
  return useQuery({ queryKey: ["devices"], queryFn: readDevices, staleTime: 30_000, refetchInterval: streamRefetchInterval(120_000, 60_000), refetchIntervalInBackground: false, retry: false });
}

/** Pure: the device this session is on. Your own paired PC first, then the primary, then the first worker. */
export function activeDevice(devices: readonly DeviceRow[]): DeviceRow | null {
  const workers = devices.filter((d) => d.kind !== "hub");
  return workers.find((d) => d.mine) ?? workers.find((d) => d.primary) ?? workers[0] ?? devices.find((d) => d.mine) ?? null;
}

export function deviceSlotInput(d: DeviceRow | null): DeviceSlotInput | null {
  return d ? { deviceId: d.id, label: d.label ?? null, isThisPc: d.mine ?? null, online: typeof d.online === "boolean" ? d.online : null } : null;
}

export type Me = { id: string; name: string } | null;

/** The signed-in person (GET /__devices/me), or null when it can't be read. */
export function useMe() {
  return useQuery({
    queryKey: ["devices-me"],
    queryFn: async (): Promise<Me> => {
      const r = await fetch("/__devices/me", { cache: "no-store" });
      if (!r.ok) return null;
      const b = (await r.json()) as { person?: { id?: string; name?: string } | null };
      return b.person?.id ? { id: b.person.id, name: b.person.name ?? b.person.id } : null;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
