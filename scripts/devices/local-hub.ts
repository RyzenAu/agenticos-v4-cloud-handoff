#!/usr/bin/env bun
/**
 * An ISOLATED hub for the real local proof (programme 20261001, Agent B). NOT the OS: no UI, no Vite, none of the
 * live server's other plugins. It mounts the REAL pieces the cloud hub uses for this path, on its own port and its own
 * data directory:
 *
 *   /__devices/*                     createDevicesService  (pairing, companion long-poll, registry, dispatcher), hub role "cloud"
 *   /__operator/screen/command*      commandRoute + createCommandService (the ONE Jarvis command path) + a real JobService
 *   /__proof/*                       read-only evidence (devices, recent commands, jobs) and two test hooks (arm-cancel, pair code file)
 *
 *   bun scripts/devices/local-hub.ts --port 8095 --data D:\agent-scratch\prog-b\proof
 *
 * Isolation: it refuses port 8081, refuses a data folder inside any AgenticOS checkout's .operator-data, and sets
 * MU_DATA_DIR / MU_HUB_ROLE=cloud for ITSELF only. Loopback only (127.0.0.1). The pairing code is written to
 * <data>/pair-code.txt (this throwaway hub's own secret; not printed). Nothing here reads .env or any live store.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(arg("port") ?? 8095);
const dataArg = arg("data");
if (!dataArg) throw new Error("Give --data <a scratch folder>.");
if (port === 8081 || !Number.isInteger(port) || port < 1024) throw new Error("That port isn't a spare one (8081 is the live OS).");
const data = resolve(dataArg);
if (/[\\/]\.operator-data([\\/]|$)/i.test(data)) throw new Error("Refusing to use an .operator-data folder: pass an isolated scratch folder.");
const root = join(data, "hub-root");
const dataDir = join(root, ".operator-data");
mkdirSync(dataDir, { recursive: true });
process.env.MU_DATA_DIR = dataDir;
process.env.MU_HUB_ROLE = "cloud";

const { createDevicesService } = await import("./service");
const { resolveTarget } = await import("./route");
const { JobService } = await import("../jobs/service");
const { createCommandService } = await import("../jarvis-command/service");
const { commandRoute } = await import("../jarvis-command/route");
const { resolvePrincipal } = await import("../identity/principal");
const { SESSION_COOKIE } = await import("./identity");
// --simulate-serve: Tailscale Serve is SIMULATED for the second person (the real check needs the tailscaled peer), exactly as the
// test harness does: a loopback socket, the tailnet Host, a Tailscale-User-Login listed in people.json and a tailnet source address.
// Usman stays the loopback owner. This is how a synthetic Mehroz connects without Tailscale.
const simulate = argv.includes("--simulate-serve");
const { TAILNET, SIMULATED_SERVE, SIMULATED_TAILNET, LOGINS } = await import("./test-harness");
if (simulate)
  writeFileSync(join(dataDir, "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: [LOGINS.usman] }, { name: "Mehroz", role: "co-founder", tailscale: [LOGINS.mehroz] }] }));
const identityCtx = simulate ? { tailnetName: TAILNET, servePeer: SIMULATED_SERVE, tailnet: SIMULATED_TAILNET } : {};

const devices = createDevicesService({ root, hubRole: "cloud", maxWaitMs: 25_000, ...identityCtx });
const jobs = new JobService({ path: join(dataDir, "jobs.sqlite"), stopGraceMs: 1500, snapshotMs: 0 });
// What the real OS does at startup (scripts/jobs/runtime.ts, by the single recovery owner): a job that was running is now UNKNOWN (never re-run),
// a queued one is interrupted. Without this a restarted isolated hub would show a dead job as running forever.
jobs.recover();
const service = createCommandService({
  jobs: () => jobs,
  entry: () => null,
  hubDeviceId: devices.hubIsDevice ? "usman-pc" : "",
  resolveTarget: (ctx) => resolveTarget(ctx, devices.registry),
  dispatcher: devices.dispatcher,
  micOwner: (p) => devices.registry.micOwner(p),
  deviceLabel: (id) => devices.registry.all().find((d) => d.id === id)?.label ?? id,
  remoteTimeoutMs: 90_000,
});

// The first pairing code for Usman's companion, redeemed over loopback by `companion pair`. Written to the scratch folder only.
const code = devices.store.createCode("usman", "companion", "usman");
writeFileSync(join(data, "pair-code.txt"), code.code);
if (simulate) writeFileSync(join(data, "pair-code-mehroz.txt"), devices.store.createCode("mehroz", "companion", "mehroz").code);

// One-shot test hook: the next job's first successful companion step triggers a cancel, synchronously, so the
// "cancelled after step 1" proof does not depend on a race between a person's click and the next dispatch.
let armed = false;
jobs.subscribe((e) => {
  if (armed && e.type === "step" && e.step.executor === "companion" && e.step.outcome === "ok") {
    armed = false;
    void jobs.cancel(e.jobId);
  }
});

function send(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const text = Buffer.concat(chunks).toString();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path.startsWith("/__devices")) return void (await devices.handle(req, res));
      if (path.startsWith("/__operator/screen/command")) {
        const principal = resolvePrincipal(req as never, { root, store: devices.store, ...identityCtx });
        if (!principal) return send(res, { error: "Sign in first" }, 401);
        const body = req.method === "POST" ? await readBody(req) : null;
        const handled = await commandRoute({ path: path.replace(/^\/__operator/, ""), method: req.method ?? "GET", url, body, principal, req, res, service, send: (v, s) => send(res, v, s) });
        if (!handled) send(res, { error: "Not found" }, 404);
        return;
      }
      if (path === "/__proof/state") {
        const principal = resolvePrincipal(req as never, { root, store: devices.store, ...identityCtx });
        const view = (await fetchDevicesAsOwner()) ?? [];
        return send(res, { hubRole: devices.hubRole, hubIsDevice: devices.hubIsDevice, principal: principal ? { personId: principal.personId, via: principal.via } : null, devices: view, commands: devices.dispatcher.recent(50) });
      }
      if (path === "/__proof/job") {
        const job = jobs.get(url.searchParams.get("id") ?? "");
        return send(res, job ? { id: job.id, state: job.state, note: job.note ?? null, targetDeviceId: job.targetDeviceId, steps: job.steps.map((s) => ({ seq: s.seq, executor: s.executor, action: s.action ?? null, outcome: s.outcome, ms: s.ms, intent: s.intent, verification: s.verification ?? null })) } : { error: "no such job" }, job ? 200 : 404);
      }
      if (path === "/__proof/arm-cancel" && req.method === "POST") {
        armed = true;
        return send(res, { armed: true });
      }
      if (path === "/__proof/revoke" && req.method === "POST") {
        const b = (await readBody(req)) as { deviceId?: string };
        const d = devices.store.companions().find((c) => c.id === String(b.deviceId ?? ""));
        if (!d) return send(res, { error: "no such companion" }, 404);
        devices.store.revokeCompanion(d.id);
        devices.dispatcher.deviceOffline(d.id);
        return send(res, { revoked: d.id });
      }
      if (path === "/__proof/new-code" && req.method === "POST") {
        const b = (await readBody(req)) as { who?: string };
        const who = b.who === "mehroz" ? "mehroz" : "usman";
        writeFileSync(join(data, `pair-code-${who}.txt`), devices.store.createCode(who, "companion", who).code);
        return send(res, { file: `pair-code-${who}.txt` });
      }
      if (path === "/__proof/health") return send(res, { ok: true, port, hubRole: devices.hubRole });
      send(res, { error: "Not found" }, 404);
    } catch (error) {
      if (!res.headersSent) send(res, { error: String((error as Error)?.message ?? error).slice(0, 200) }, 500);
    }
  })();
});

/** The /devices listing as Usman's own loopback session would see it (owner view), for evidence. */
async function fetchDevicesAsOwner() {
  const cookie = encodeURIComponent(devices.store.mintSession("usman", "proof", "hub").cookie);
  const res = await fetch(`http://127.0.0.1:${port}/__devices/devices`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}`, host: `127.0.0.1:${port}` } }).catch(() => null);
  const json = (await res?.json().catch(() => null)) as { devices?: unknown[] } | null;
  return json?.devices ?? null;
}

server.listen(port, "127.0.0.1", () => console.log(`isolated hub on http://127.0.0.1:${port}  data=${dataDir}  role=${devices.hubRole}`));
const stop = () => {
  devices.close();
  try {
    jobs.close();
  } catch {
    /* running */
  }
  server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
