/**
 * The live hub services the Dot gateway's routes (hub-ops.ts) call, handed over by the plugin that creates them
 * (scripts/operator-plugin.ts). The gateway's plugin is mounted before those services exist, so it reads them lazily here.
 *
 *   commands    Dot's command service: the founders' wiring and delegates (business, CRM and leads through Dot's CRM guard,
 *               compound questions, agents on the shared bot computers, coding as Dot, skills) with Dot's principal. Excluded:
 *               the hub's own desktop (no entry), the founders' devices (resolveTarget: "dot" owns none), the founders' private
 *               conversations, mail and vault (no memory-by-words; Dot's memory is the shared-bucket /memory route).
 *   brain       the founders' typed-lane brain, run server-side for Dot's plain questions.
 *   computers   the shared bot computers service (one per hub).
 *
 * Nothing here is a credential, and nothing is reachable without the gateway's own capability checks.
 */
import { resolve } from "node:path";
import type { ComputersService } from "../computers/service";
import type { CommandService } from "../jarvis-command/service";
import type { MailArchiveLike } from "./mail";
import type { ReleaseDesk } from "./release";

/** The founders' typed-lane brain, answer-only and server-side: Dot's plain question in, the brain's reply out (null: no answer). */
export type GatewayBrain = (utterance: string, principal: never) => Promise<string | null>;

export type GatewayHubServices = { brain?: GatewayBrain; commands?: CommandService; computers?: ComputersService; /** The hub's mail archive (operator-plugin's instance). */ mail?: MailArchiveLike; /** The release desk (hub-plugin.ts builds it when releases are switched on). */ release?: ReleaseDesk };

const byRoot = new Map<string, GatewayHubServices>();

export function provideGatewayServices(root: string, services: GatewayHubServices) {
  const key = resolve(root);
  byRoot.set(key, { ...byRoot.get(key), ...services });
}

export function gatewayServices(root: string): GatewayHubServices {
  return byRoot.get(resolve(root)) ?? {};
}
