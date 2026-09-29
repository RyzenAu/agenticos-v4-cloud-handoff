/**
 * Which machine a Jarvis command runs on, asked BEFORE any desktop, browser or app action (Wave 2
 * contract: the Jev track calls the devices track's `resolveTarget()` first).
 *
 * The devices track writes `scripts/devices/route.ts` in its worktree; until the lead merges it, this
 * module codes against the documented interface and uses a local stub that only ever resolves to THIS
 * PC for owner "usman" and refuses everyone and everything else. When the real module is present it is
 * loaded at runtime and used instead (no silent fallback to this PC for anyone else: that rule is the
 * devices module's own, and the stub keeps it).
 *
 * The executors here run on THIS PC only. A command that resolves to another device (Mehroz's laptop,
 * a companion) is refused here with a plain reason: remote dispatch is the devices track's job.
 */
export const THIS_PC_DEVICE_ID = "usman-pc";

export type ResolveContext = { personId: string; spokenTarget?: string };
export type ResolveResult = { ok: true; deviceId: string; owner: "usman" | "mehroz"; online: boolean } | { ok: false; reason: string };
export type ResolveTarget = (ctx: ResolveContext) => ResolveResult | Promise<ResolveResult>;

/** Words that name this PC ("on my PC", "here", "this computer"). */
const THIS_PC_WORDS = /^(?:(?:on|in|at|using)\s+)?(?:(?:my|this|the|usman'?s)\s+)?(?:pc|computer|desktop|machine|here|windows pc|main pc)$/i;

/** The stub: Usman → this PC; anyone else, or any other device, is refused. Pure. */
export function stubResolveTarget(ctx: ResolveContext): ResolveResult {
  const person = String(ctx?.personId ?? "").trim().toLowerCase();
  if (person !== "usman") return { ok: false, reason: person ? `commands from ${person} can't run yet: device routing (the devices track) isn't merged, and this PC is Usman's` : "unknown person" };
  const spoken = String(ctx.spokenTarget ?? "").trim();
  if (spoken && !THIS_PC_WORDS.test(spoken)) return { ok: false, reason: `only this PC is routable until device routing is merged; "${spoken.slice(0, 40)}" isn't this PC` };
  return { ok: true, deviceId: THIS_PC_DEVICE_ID, owner: "usman", online: true };
}

let loaded: Promise<{ resolve: ResolveTarget; source: "devices" | "stub" }> | null = null;
/** The devices track's resolveTarget when it's merged (runtime import), else the stub. Cached. */
export function loadResolveTarget(importer: (spec: string) => Promise<unknown> = (spec) => import(spec)): Promise<{ resolve: ResolveTarget; source: "devices" | "stub" }> {
  loaded ??= (async () => {
    try {
      const mod = (await importer(new URL("./devices/route.ts", import.meta.url).href)) as { resolveTarget?: unknown };
      if (typeof mod?.resolveTarget === "function") {
        const real = mod.resolveTarget as (ctx: ResolveContext) => ResolveResult;
        return { resolve: (ctx: ResolveContext) => real(ctx), source: "devices" as const };
      }
    } catch {
      // not merged yet
    }
    return { resolve: stubResolveTarget, source: "stub" as const };
  })();
  return loaded;
}

export type LocalTarget = { ok: true; deviceId: string; owner: "usman" | "mehroz"; source: "devices" | "stub" } | { ok: false; said: string; source: "devices" | "stub" };
/**
 * Resolve, then insist on THIS PC: the local executors never act for another device. Never throws.
 */
export async function localTarget(ctx: ResolveContext, resolver?: { resolve: ResolveTarget; source: "devices" | "stub" }): Promise<LocalTarget> {
  const { resolve, source } = resolver ?? (await loadResolveTarget());
  let result: ResolveResult;
  try {
    result = await resolve(ctx);
  } catch (error) {
    return { ok: false, said: `I couldn't work out which machine that's for (${(error as Error).message.slice(0, 80)}), so I did nothing.`, source };
  }
  if (!result.ok) return { ok: false, said: `Not done: ${result.reason}. Nothing was touched.`, source };
  if (!result.online) return { ok: false, said: "That machine is offline, so nothing was done.", source };
  if (result.deviceId !== THIS_PC_DEVICE_ID) return { ok: false, said: `That's for ${result.deviceId}, not this PC; sending it there isn't wired up yet, so nothing was done.`, source };
  return { ok: true, deviceId: result.deviceId, owner: result.owner, source };
}
