/**
 * The live hub services the Dot gateway's routes (hub-ops.ts) call, handed over by the plugin that creates them
 * (scripts/operator-plugin.ts). The gateway's plugin is mounted before those services exist, so it reads them lazily here.
 *
 *   commands    Dot's OWN command service: the same Jev-led command path over the same job store, built with ONLY the lanes
 *               the gateway may use (no hub screen, no founder's device, no bot conversations, no receptionist, leads,
 *               memory-by-voice or skills). Never the founders' instance.
 *   computers   the shared bot computers service (one per hub).
 *
 * Nothing here is a credential, and nothing is reachable without the gateway's own capability checks.
 */
import { resolve } from "node:path";
import type { ComputersService } from "../computers/service";
import type { CommandService } from "../jarvis-command/service";
import type { MailArchiveLike } from "./mail";
import type { ReleaseDesk } from "./release";

export type GatewayHubServices = { commands?: CommandService; computers?: ComputersService; /** The hub's mail archive (operator-plugin's instance). */ mail?: MailArchiveLike; /** The release desk (hub-plugin.ts builds it when releases are switched on). */ release?: ReleaseDesk };

const byRoot = new Map<string, GatewayHubServices>();

export function provideGatewayServices(root: string, services: GatewayHubServices) {
  const key = resolve(root);
  byRoot.set(key, { ...byRoot.get(key), ...services });
}

export function gatewayServices(root: string): GatewayHubServices {
  return byRoot.get(resolve(root)) ?? {};
}
