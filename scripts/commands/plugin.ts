// /__commands: what the ONE command palette (and Jarvis voice, Track 2) needs from the server to show a
// device action honestly BEFORE it runs (src/lib/commands; NEXUS-ADDENDUM items 1 and 7):
//
//   GET /__commands/target?spoken=here    resolveTarget for the SIGNED-IN person: the device a command would
//                                         run on (label, owner, online) or why it can't run. Never another
//                                         person's device; the hub is never a fallback for anyone else.
//   GET /__commands/apps                  installed Windows app NAMES on the requester's own device. The index
//                                         is kept for the hub only, so it is served only when the requester's
//                                         default target is the hub and they own it; anyone else gets
//                                         "setup-required" with the reason (their companion, Stage H).
//   GET /__commands/files?q=name          authorised document NAMES (scripts/jev-files.ts fences: authorised
//                                         roots, no secret-bearing names, no executables) on the requester's
//                                         own device, same rule as apps. Names only, never contents.
//
// Nothing here runs anything: a device action is sent to the existing Jarvis entry
// (POST /__operator/screen/command), which resolves the target again and records the job.
// Every request needs a verified browser principal (Stage B1) AND that principal's own page token.
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, relative } from "node:path";
import type { Plugin } from "vite";
import { pageTokenMatches, requestPrincipal } from "../identity/gate";
import { isBrowserPrincipal, type Principal } from "../identity/principal";
import { activeRegistry, HUB_DEVICE_ID, type DeviceRegistry } from "../devices/registry";
import { resolveTarget } from "../devices/route";
import { fileRoots, findFiles } from "../jev-files";
import { startAppsReady, type StartApp } from "../pc-hands";

export type CommandsDeps = {
  registry?: () => DeviceRegistry;
  apps?: () => Promise<StartApp[]>;
  files?: (q: string) => string[];
  roots?: () => string[];
  platform?: string;
};

type Reply = { status: number; body: unknown };

const HUB_ONLY = "The installed-app and file index is kept for Usman's PC only; your own device's index comes with its companion (Stage H).";

/** The target a signed-in person's command would run on, for display. Pure over the registry. */
export function previewTarget(principal: Principal, spoken: string | undefined, registry: DeviceRegistry) {
  // "here" / "on this pc" is the device the request came from, not a device name: resolveTarget's origin rule.
  const here = !!spoken && isHere(spoken);
  const r = resolveTarget(
    { personId: principal.personId, ...(spoken && !here ? { spokenTarget: spoken } : {}), ...(here && principal.deviceId ? { originDeviceId: principal.deviceId } : {}) },
    registry,
  );
  const device = r.deviceId ? registry.all().find((d) => d.id === r.deviceId) : undefined;
  if (r.ok) return { ok: true as const, deviceId: r.deviceId, label: device?.label ?? r.deviceId, owner: r.owner, online: true as const, routing: "devices" as const };
  // Only ever name a device the requester owns (resolveTarget never returns someone else's id, but be sure).
  const own = device && device.owner === principal.personId ? device : undefined;
  return { ok: false as const, reason: r.reason, ...(own ? { deviceId: own.id, label: own.label } : {}), routing: "devices" as const };
}

/** "here", "on this pc", "on this computer": the requester's current device. Same words as src/lib/commands/registry.ts. */
export function isHere(spoken: string) {
  return /^(?:here|on this (?:pc|computer|desktop|machine|laptop|device))$/i.test(spoken.trim());
}

/** The requester's default device is the hub and they own it: only then does the hub's index describe "their device". */
function hubIsTheirs(principal: Principal, registry: DeviceRegistry) {
  const r = resolveTarget({ personId: principal.personId }, registry);
  return r.ok && r.deviceId === HUB_DEVICE_ID && r.owner === principal.personId;
}

export async function commandsRoute(path: string, url: URL, principal: Principal, deps: CommandsDeps = {}): Promise<Reply> {
  const registry = (deps.registry ?? activeRegistry)();
  if (path === "/target") {
    const spoken = (url.searchParams.get("spoken") ?? "").trim().slice(0, 60) || undefined;
    return { status: 200, body: previewTarget(principal, spoken, registry) };
  }
  if (path === "/apps") {
    if (!hubIsTheirs(principal, registry)) return { status: 200, body: { state: "setup-required", reason: HUB_ONLY, items: [] } };
    if ((deps.platform ?? process.platform) !== "win32") return { status: 200, body: { state: "setup-required", reason: "The installed-app index needs Windows.", items: [] } };
    const apps = await (deps.apps ?? startAppsReady)().catch(() => [] as StartApp[]);
    if (!apps.length) return { status: 200, body: { state: "failed", reason: "Windows didn't return its list of apps, so apps can't be opened by name yet.", items: [] } };
    const names = [...new Set(apps.map((a) => a.name))].sort((a, b) => a.localeCompare(b));
    return { status: 200, body: { state: "live", lastSuccess: new Date().toISOString(), items: names.map((name) => ({ name })) } };
  }
  if (path === "/files") {
    if (!hubIsTheirs(principal, registry)) return { status: 200, body: { state: "setup-required", reason: HUB_ONLY, items: [] } };
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
    if (q.length < 2) return { status: 200, body: { state: "unknown", reason: "Type two or more characters of a file name.", items: [] } };
    const roots = (deps.roots ?? fileRoots)();
    const found = (deps.files ?? ((name: string) => findFiles(name, roots)))(q).slice(0, 12);
    return {
      status: 200,
      body: {
        state: "live",
        lastSuccess: new Date().toISOString(),
        // Names and the folder relative to its authorised root; never contents, never an absolute path.
        items: found.map((full) => {
          const root = roots.find((r) => full.toLowerCase().startsWith(r.toLowerCase())) ?? dirname(full);
          const where = relative(root, dirname(full)).replace(/\\/g, "/");
          return { name: basename(full), where: `${basename(root)}${where ? `/${where}` : ""}` };
        }),
      },
    };
  }
  return { status: 404, body: { error: "Not found" } };
}

export function commandsMiddleware(options: { root: string; token: () => string; deps?: CommandsDeps }) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = String(req.url ?? "/").split("?")[0];
    const url = new URL(req.url ?? "/", "http://localhost");
    // Mounted at /__commands: connect strips the prefix. Plain segments only.
    if (!/^\/(?:target|apps|files)$/.test(raw)) return next();
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "GET only" });
    const principal = requestPrincipal(req as never, { root: options.root });
    if (!principal || !isBrowserPrincipal(principal)) return send(401, { error: "Sign in on this device first." });
    // The caller's OWN page token, like every other shared route: a page on another origin can't read these.
    if (!pageTokenMatches(principal, req.headers["x-claude-os-token"], options.token())) return send(403, { error: "Missing or wrong page token." });
    try {
      const r = await commandsRoute(raw, url, principal, options.deps);
      return send(r.status, r.body);
    } catch {
      return send(500, { error: "Something went wrong." });
    }
  };
}

export function commandsPlugin(options: { root: string; token: () => string; deps?: CommandsDeps }): Plugin {
  return {
    name: "agentic-commands",
    configureServer(server) {
      const handle = commandsMiddleware(options);
      server.middlewares.use("/__commands", (req, res, next) => void handle(req, res, next));
    },
  };
}
