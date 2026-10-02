// Wires the dependency monitor (scripts/ops/dependencies.ts) into the hub: starts the startup check when the dev server starts, stops it when the
// server closes, and hands /__health a live snapshot. Quiet read-only copies (AGENTIC_OS_NO_BACKGROUND, previews, tests) never probe anything.
import type { Plugin } from "vite";
import { activeRegistry } from "../devices/registry";
import { DEFAULT_HINDSIGHT_URL, loopbackUrl } from "../memory/settings";
import { routerHealthStore } from "../model-router/health";
import { backgroundJobsDisabled } from "../preview-guard";
import { createDependencyMonitor, realChecks, type DependencyReport } from "./dependencies";

export function hubDependencyMonitor(root: string, env: Record<string, string | undefined> = process.env) {
  const raw = (env.HINDSIGHT_URL ?? "").trim() || DEFAULT_HINDSIGHT_URL;
  const hindsightUrl = /^off$/i.test(raw) ? "off" : (loopbackUrl(raw) ?? "off");
  const monitor = createDependencyMonitor({
    checks: realChecks({
      searxngUrl: env.MU_SEARXNG_URL,
      hindsightUrl,
      companions: () => {
        const reg = activeRegistry();
        const comps = reg.targets().filter((d) => d.kind === "companion");
        return { online: comps.filter((d) => reg.isOnline(d)).length, total: comps.length };
      },
      modelHealth: () => {
        const snap = routerHealthStore(root).snapshot();
        return { states: Object.values(snap.models).map((m) => m.state) };
      },
    }),
  });
  return monitor;
}

export type HubMonitor = ReturnType<typeof hubDependencyMonitor>;

/** The monitor starts with the dev server (never during `vite build`) and is stopped when the server closes. */
export function dependencyMonitorPlugin(root: string, monitor: HubMonitor, env: Record<string, string | undefined> = process.env): Plugin {
  return {
    name: "mu-dependency-monitor",
    apply: "serve",
    configureServer(server) {
      if (backgroundJobsDisabled(env)) return;
      void monitor.startup().catch((e) => console.error(`[health] startup check failed to run: ${(e as Error).message}`));
      server.httpServer?.once("close", () => monitor.stop());
    },
  };
}

export const noDependencies = (): DependencyReport[] => [];
