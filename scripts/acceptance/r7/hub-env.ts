import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The computer-host environment for a `local-wsl` seed: the seed's own gate-host.json (MU_COMPUTERS_* names only, never a secret), plus this run's
 * own computers folder and display range so it never shares a screen or a folder with another worker's hub on the same WSL.
 */
export function hostEnvFor(dataDir: string, opts: { computersHome?: string; displayBase?: string; monitorMs?: string } = {}): Record<string, string> {
  const file = join(dataDir, "gate-host.json");
  if (!existsSync(file)) return {};
  const h = JSON.parse(readFileSync(file, "utf8")) as { env?: Record<string, string> };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(h.env ?? {})) {
    if (!/^MU_COMPUTERS_[A-Z_]+$/.test(k)) throw new Error(`Refusing the environment name ${k} in gate-host.json`);
    env[k] = String(v);
  }
  if (!env.MU_COMPUTERS_WSL_DISTRO) return env;
  if (opts.computersHome) {
    if (!/^\/home\/[^/]+\/mu-computers-[a-z0-9-]+$/.test(opts.computersHome)) throw new Error("--computers-home must be /home/<user>/mu-computers-<run> (never a shared folder)");
    env.MU_COMPUTERS_HOME = opts.computersHome;
    env.WSLENV = "MU_COMPUTERS_HOME";
  }
  if (opts.displayBase) env.MU_COMPUTERS_DISPLAY_BASE = String(Number(opts.displayBase));
  env.MU_COMPUTERS_MONITOR_MS = opts.monitorMs || "5000";
  return env;
}

/** The arguments run-all hands to every journey: the same hub, data folder, output folder and served tree as the run itself (and journey L's own port for its restored hub). */
export const FORWARDED = ["hub", "data", "out", "repo", "restore-port"] as const;
export function forwardArgs(argv: readonly string[]): string[] {
  return argv.filter((a, i) => FORWARDED.some((n) => a === `--${n}` || argv[i - 1] === `--${n}`));
}

/**
 * What a journey must hand to hub.ts when it stops or restarts ITS hub: the same port, data folder and served tree it was started with. Without
 * these hub.ts falls back to its defaults (8128, D:\AgenticOS-r7-data\h) and would stop or start a DIFFERENT run's hub.
 */
export function hubArgsFor(hub: string, data: string, repo = ""): string[] {
  return ["--port", new URL(hub).port, "--data", data, ...(repo ? ["--repo", repo] : [])];
}
