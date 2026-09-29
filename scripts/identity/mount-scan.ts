import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every /__* route mounted anywhere in the app's server code, found by reading the source (the
 * mounts live inline in vite.config.ts and in each plugin). Used by the route-classification test,
 * which fails when a mount is missing from scripts/identity/routes.ts or docs/IDENTITY-ROUTES.md.
 */
const MOUNT = /middlewares\.use\(\s*"(\/__[^"]*)"/g;
const PREFIX = /const prefix = "(\/__[^"]*)"/g; // installHiggsfieldAccountRoutes
const MOTION = /pathname\.startsWith\("(\/__[a-z_-]+)\//g; // the motion plugin's own dispatcher
const DEV_RESTART = /path === "(\/__dev_restart)"/g;
// A middleware that matches its own paths with a regex literal, e.g. B2's /^\/__(jobs|approvals)(\/|$)/
// or /^\/__jobs(\/|$)/. Written as source text: "/^\/__(" then the names.
const REGEX_GROUP = /\/\^\\\/__\(([a-z_|-]+)\)/g;
const REGEX_ONE = /\/\^\\\/(__[a-z_-]+)[(\\$]/g;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    // Not tests, and not this scanner (its own comments quote the patterns it looks for).
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "mount-scan.ts") out.push(p);
  }
  return out;
}

export function scanMounts(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const sources = [join(root, "vite.config.ts"), ...files(join(root, "scripts")), ...files(join(root, "src", "motion", "server"))];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    const where = relative(root, file).replace(/\\/g, "/");
    const add = (path: string) => found.set(path, [...(found.get(path) ?? []), where]);
    for (const re of [MOUNT, PREFIX, MOTION, DEV_RESTART]) for (const m of text.matchAll(re)) add(m[1].replace(/\/+$/, ""));
    for (const m of text.matchAll(REGEX_GROUP)) for (const name of m[1].split("|")) add(`/__${name}`);
    for (const m of text.matchAll(REGEX_ONE)) add(`/${m[1]}`);
  }
  return found;
}
