// Shared test rig for Track B round 3 (not a test): the REAL command service and job store, a SYNTHETIC device
// (scripts/devices/synthetic.ts, with a browser.navigate executor added), and an in-process transport that answers the
// client's POST /__operator/screen/command with the real service. No network, no model, no real device.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../identity/principal";
import { resolveTarget } from "../devices/route";
import { SYNTHETIC_MEHROZ_PC_ID, SyntheticCompanion, syntheticExecutors, syntheticWorld, type RanCall } from "../devices/synthetic";
import type { JarvisEntry } from "../jev-command";
import { JobService } from "../jobs/service";
import { COMMAND_PATH, type CommandPost } from "../../src/lib/jarvis-command";
import type { CommandBody, CommandStreamEvent } from "./contracts";
import { createCommandService } from "./service";

export const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", displayName: "Mehroz" };
export { SYNTHETIC_MEHROZ_PC_ID };

export type Lead = { name: string; website: string | null };

export function rig(leads: Record<string, Lead> = {}, cleanups: Array<() => Promise<void> | void> = []) {
  const world = syntheticWorld({ start: false });
  const ran: RanCall[] = [];
  const companion = new SyntheticCompanion(
    world.dispatcher,
    world.registry,
    SYNTHETIC_MEHROZ_PC_ID,
    "mehroz",
    {
      ...syntheticExecutors(ran, "mehroz"),
      "browser.navigate": async (args) => (
        ran.push({ executor: "browser.navigate", args: { ...args }, personId: "mehroz" }),
        { ok: true, said: `${String(args.url)} is open in the browser (SYNTHETIC).`, verified: true, evidence: "synthetic check", data: { url: String(args.url), title: "Synthetic", targetId: "t1" } }
      ),
    },
    world.clock.now,
  ).start();
  const dir = mkdtempSync(join(tmpdir(), "r3-rig-"));
  const jobs = new JobService({ path: join(dir, "jobs.sqlite"), stopGraceMs: 500, snapshotMs: 0 });
  const entry = { handle: async () => ({ type: "done", ok: true, said: "hub ran it", kind: "app", jobId: null, runId: "", targetDeviceId: "hub" }) } as unknown as JarvisEntry;
  const leadLookups: string[] = [];
  const service = createCommandService({
    jobs: () => jobs,
    entry: () => entry,
    hubDeviceId: "synthetic-usman-hub",
    resolveTarget: (ctx) => resolveTarget(ctx, world.registry),
    dispatcher: world.dispatcher,
    micOwner: (p) => world.registry.micOwner(p),
    deviceLabel: (id) => world.registry.all().find((d) => d.id === id)?.label ?? id,
    delegates: { leadSite: async (id) => (leadLookups.push(id), leads[id] ?? null) },
    graceMs: 100,
  });
  cleanups.push(async () => {
    await companion.stop();
    world.dispatcher.close();
    try {
      jobs.close();
    } catch {
      /* closing */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const wire: Array<{ path: string; body: CommandBody }> = [];
  /** The client's transport, in process: what the browser would POST to /__operator/screen/command, answered by the real service. */
  const post: CommandPost = async (path, body) => {
    wire.push({ path, body: body as CommandBody });
    if (path !== COMMAND_PATH) return new Response("not found", { status: 404 });
    const events: CommandStreamEvent[] = [];
    await service.run({ principal: mehroz, body: body as CommandBody }, (e) => void events.push(e));
    return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), { status: 200 });
  };
  return { ran, jobs, service, post, wire, leadLookups, world };
}
export type Rig = ReturnType<typeof rig>;
