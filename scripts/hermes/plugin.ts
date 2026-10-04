// /__hermes_skill_sync and /__hermes_owner_profile: the Hermes page's "Give Hermes my skills" and
// "Who Hermes thinks you are" cards (W-C, 29 Sep 2026).
//
//   GET  /__hermes_skill_sync     → the last sync's report (from Hermes' skills folder), or null
//   POST /__hermes_skill_sync     → run the sync now ({ dryRun?: boolean }) in a child process
//   GET  /__hermes_owner_profile  → what USER.md holds now, what a refresh would write, and whether they match
//   POST /__hermes_owner_profile  → refresh the owner entries in USER.md ({ dryRun?: boolean })
//
// Unlisted in the identity route table, so both are hub-only (the owner at this PC). POSTs also
// need the caller's page token. No request waits on a slow read: GETs are small file reads and
// the skills sync (which hashes every skill file) runs in its own process.
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { readLimitedText } from "../http/body";
import { runCapture } from "../nonblocking-exec";
import { customiseRoots, runProfile } from "../hermes-customise";
import { ownerProfileState } from "./owner-profile";
import { readLastReport, type SyncReport } from "./skill-sync";

type Req = IncomingMessage & { method?: string };

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function hermesCustomisePlugin(options: {
  root: string;
  atHub: (req: Req) => boolean;
  tokenOk: (req: Req) => boolean;
  hermesBin: () => string | undefined;
  /** Test seam: run the skills sync (defaults to a child `bun run scripts/hermes-customise.ts skills --json`). */
  runSkillSync?: (dryRun: boolean) => Promise<SyncReport>;
}): Plugin {
  let running: Promise<SyncReport> | null = null;
  const runSkillSync =
    options.runSkillSync ??
    (async (dryRun: boolean) => {
      const args = ["run", join(options.root, "scripts", "hermes-customise.ts"), "skills", "--json", ...(dryRun ? ["--dry-run"] : [])];
      const res = await runCapture(process.execPath, args, { cwd: options.root, env: process.env, timeout: 180_000 });
      if (res.timedOut) throw new Error("The skills sync took longer than 3 minutes and was stopped.");
      const line = res.stdout.trim().split(/\r?\n/).pop() ?? "";
      try {
        return JSON.parse(line) as SyncReport;
      } catch {
        throw new Error(`The skills sync failed${res.status !== null ? ` (exit ${res.status})` : ""}.`);
      }
    });

  const guard = (req: Req, res: ServerResponse, write: boolean) => {
    if (!options.atHub(req)) {
      send(res, 403, { error: "Only the owner at this PC can change Hermes." });
      return false;
    }
    if (write && !options.tokenOk(req)) {
      send(res, 403, { error: "bad token" });
      return false;
    }
    return true;
  };

  const readDryRun = async (req: Req, res: ServerResponse): Promise<boolean | null> => {
    const text = await readLimitedText(req, res, 4_000);
    if (text === null) return null;
    try {
      return (JSON.parse(text || "{}") as { dryRun?: unknown }).dryRun === true;
    } catch {
      send(res, 400, { error: "invalid json" });
      return null;
    }
  };

  return {
    name: "hermes-customise",
    configureServer(server) {
      server.middlewares.use("/__hermes_skill_sync", (req: Req, res, next) => {
        if (req.method !== "GET" && req.method !== "POST") return next();
        if (!guard(req, res, req.method === "POST")) return;
        const roots = customiseRoots();
        if (req.method === "GET") return send(res, 200, { report: readLastReport(roots.hermesHome), running: running !== null });
        void (async () => {
          const dryRun = await readDryRun(req, res);
          if (dryRun === null) return;
          if (running && !dryRun) return send(res, 409, { error: "A sync is already running." });
          const job = runSkillSync(dryRun);
          if (!dryRun) {
            running = job;
            void job.catch(() => undefined).finally(() => {
              running = null;
            });
          }
          try {
            send(res, 200, { report: await job });
          } catch (e) {
            send(res, 500, { error: (e as Error).message });
          }
        })();
      });

      server.middlewares.use("/__hermes_owner_profile", (req: Req, res, next) => {
        if (req.method !== "GET" && req.method !== "POST") return next();
        if (!guard(req, res, req.method === "POST")) return;
        const roots = customiseRoots();
        if (req.method === "GET") {
          try {
            return send(res, 200, { state: ownerProfileState(roots) });
          } catch (e) {
            return send(res, 500, { error: (e as Error).message });
          }
        }
        void (async () => {
          const dryRun = await readDryRun(req, res);
          if (dryRun === null) return;
          try {
            const result = await runProfile(roots, dryRun, options.hermesBin() ?? null);
            send(res, result.ok ? 200 : 422, result);
          } catch (e) {
            send(res, 500, { error: (e as Error).message });
          }
        })();
      });
    },
  };
}
