import { isPersonId, isSharedComputer, type PersonId, type TargetDevice } from "../devices/types";

/**
 * Who may use which device. One table, used by the computers API, the job runner and the tests:
 *
 *   target                        Usman     Mehroz
 *   Usman's PC (personal)         allowed   denied
 *   Mehroz's PC (personal)        denied    allowed
 *   shared agent cloud computer   control + takeover, both
 *
 * An agent inherits the permitted targets of the person who started it (`by`); it never gets more. The same rule is
 * enforced where a command is routed (devices/route.ts resolveTarget: personal devices only for their owner, shared
 * computers by name or `computer:<id>`); this module answers it for the API and explains refusals.
 */

export type Decision = { allowed: true } | { allowed: false; reason: string };

const DENY = (reason: string): Decision => ({ allowed: false, reason });

/** May this person control this device (send commands, take it over)? */
export function mayControl(person: string | null | undefined, device: Pick<TargetDevice, "kind" | "owner" | "label">): Decision {
  if (!isPersonId(person)) return DENY("Sign in as Usman or Mehroz first.");
  if (isSharedComputer(device)) return { allowed: true };
  if (device.owner === person) return { allowed: true };
  return DENY(`${device.label} belongs to ${device.owner}; you can only control your own devices and the shared cloud computers.`);
}

/** The devices this person (and any agent they start) may target: their own, plus every shared cloud computer. */
export function permittedTargets<T extends Pick<TargetDevice, "kind" | "owner" | "label">>(person: PersonId, devices: readonly T[]): T[] {
  return devices.filter((d) => mayControl(person, d).allowed);
}

/** Only shared computers take a lease-based takeover; a personal PC is never taken over from its owner. */
export function mayTakeOver(person: string | null | undefined, device: Pick<TargetDevice, "kind" | "owner" | "label">): Decision {
  if (!isSharedComputer(device)) return DENY("Only shared cloud computers can be taken over.");
  return mayControl(person, device);
}
