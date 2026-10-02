// Test harness only: stand-ins for the two outward publishers (Vercel for lead previews, Blotato for social posts) so a
// throwaway hub can be driven end to end in a real browser without publishing anything.
//
// It is OFF unless ALL of these hold, so the real hub can never end up with it by accident:
//   MU_HARNESS_FAKE_PUBLISH=1, MU_HUB_ROLE=server, an explicit MU_DATA_DIR (a hub with its own data folder), and a marker file
//   `.mu-harness-scratch` INSIDE that data folder, which only harness and test setup create. If the flag is set and the marker is
//   missing (a stray environment variable on a real hub), nothing is faked and nothing real runs either: it fails closed, loudly.
// Faking can only make the hub do LESS (it posts nothing, deploys nothing); every approval rule stays exactly as in production.
// Each fake call appends a line (what, never a key or a body) to <data dir>/harness-publish.log.jsonl so a check can prove
// how many times the outward action ran.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirFor } from "../cloud/data-dir";
import type { BlotatoFetch } from "../design-publish";
import type { LeadSitesDeps } from "../lead-sites/plugin";
import { patchPreview } from "../lead-sites/registry";

export type HarnessPublish = { leadSites: Pick<LeadSitesDeps, "deploy" | "takedown">; blotato: BlotatoFetch; blotatoKey: () => string };

/** The marker harness and test setup create inside MU_DATA_DIR. Nothing in the product creates it. */
export const HARNESS_MARKER = ".mu-harness-scratch";

export function harnessFakePublish(env: Record<string, string | undefined> = process.env): HarnessPublish | null {
  if (env.MU_HARNESS_FAKE_PUBLISH !== "1" || (env.MU_HUB_ROLE ?? "").trim().toLowerCase() !== "server" || !(env.MU_DATA_DIR ?? "").trim()) return null;
  const root = join(import.meta.dir, "..", "..");
  if (!existsSync(join(dataDirFor(root, env), HARNESS_MARKER))) {
    // A real hub with the flag set by accident: never silently fake (a "published" post that never happened), never publish for real
    // under a flag that says this is a harness. Every outward call refuses with this line.
    const why = `MU_HARNESS_FAKE_PUBLISH is set but ${HARNESS_MARKER} is missing from the data folder, so publishing is disabled in this process (unset the variable, or create the marker in a throwaway harness folder).`;
    console.error(`[harness] ${why}`);
    const refuse = async () => {
      throw new Error(why);
    };
    return { leadSites: { deploy: refuse as never, takedown: refuse as never }, blotato: refuse as never, blotatoKey: () => "" };
  }
  const log = (what: string, detail: Record<string, unknown> = {}) => {
    const file = join(dataDirFor(root, env), "harness-publish.log.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), what, ...detail })}\n`);
  };
  const day = 86_400_000;
  return {
    leadSites: {
      deploy: (async (_db: unknown, leadId: number, o: { root: string; by: string }) => {
        log("lead-deploy", { leadId, by: o.by });
        const now = Date.now();
        return patchPreview(o.root, leadId, {
          status: "live", deployedAt: new Date(now).toISOString(), deployedBy: o.by, expiresAt: new Date(now + 30 * day).toISOString(), takenDownAt: null,
          verified: { at: new Date(now).toISOString(), status: 200, banner: true, noindexHeader: true }, lastError: null,
        });
      }) as never,
      takedown: (async (_db: unknown, leadId: number, o: { root: string; by: string }) => {
        log("lead-takedown", { leadId, by: o.by });
        return patchPreview(o.root, leadId, { status: "taken_down", takenDownAt: new Date().toISOString(), takenDownBy: o.by, expiresAt: null });
      }) as never,
    },
    blotatoKey: () => "harness-fake-key",
    blotato: async (_key, path, init) => {
      log("blotato", { method: init?.method ?? "GET", path });
      const ok = (json: unknown) => ({ status: 200, ok: true, json, body: JSON.stringify(json) });
      if (path === "/users/me/accounts") return ok({ items: [{ id: "acc-instagram", platform: "instagram", username: "mu_harness" }, { id: "acc-tiktok", platform: "tiktok", username: "mu_harness_tt" }] });
      if (path === "/media") return ok({ url: "https://harness.invalid/media.png" });
      return ok({ id: "harness-post" });
    },
  };
}
