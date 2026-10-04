#!/usr/bin/env bun
/**
 * Track 2 · a BOUNDED REAL device check on THIS PC (the hub), through the real command service, a real
 * Job store, the real Jarvis entry and the real executors. Harmless actions only, each labelled REAL:
 *
 *   1. "Open Notepad and type '<synthetic line>'"   a NEW empty Untitled document, read back, never saved
 *   2. "Open a new PowerPoint and add a title slide '<synthetic title>'"   never saved, read back from COM
 *   3. "Open https://example.com"   the app-owned Playwright browser (its own profile), page title checked
 *
 *   bun scripts/jarvis-command/real-device-check.ts --run [--scratch D:\agent-scratch\t2] [--only notepad|deck|web]
 *
 * No Jev key is used (no model spend): the deterministic lanes decide. Nothing is saved, sent or signed in;
 * the owner's own windows and files are never touched (the executors refuse a restored or non-empty doc).
 * Windows and the presentation it creates are left open for the owner to see; the browser is closed.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { JobService } from "../jobs/service";
import { createRunLog } from "../screen-hands/run-log";
import { createJarvisEntry } from "../jev-command";
import { staticRegistry, defaultHub } from "../devices/registry";
import { resolveTarget } from "../devices/route";
import { createWindowsExecutors, liveWindowsDeps } from "../executors/windows";
import { loadAppChromium, openAppBrowser, type AppBrowser } from "../browser/app-browser";
import { createCommandService } from "./service";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!args.includes("--run")) {
  console.log("Dry run. Add --run to perform the three harmless REAL actions on this PC.");
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("Windows only.");
const scratch = resolve(flag("--scratch") ?? "D:\\agent-scratch\\t2");
const only = flag("--only");
mkdirSync(scratch, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jobs = new JobService({ path: join(scratch, `real-check-${stamp}.sqlite`), stopGraceMs: 5000 });
const runs = createRunLog();
const deps = liveWindowsDeps({ roots: [] });
const win = createWindowsExecutors(deps);
let browser: AppBrowser | null = null;
const entry = createJarvisEntry({
  screen: { runs, act: (async () => ({ type: "done", ok: false, said: "The screen loop isn't part of this check.", steps: 0, ms: 0, stepMs: [] })) as never },
  jevKey: () => "",
  front: async () => null,
  browser: async () => {
    if (browser) return browser;
    const chromium = await loadAppChromium();
    if (!chromium) return null;
    browser = await openAppBrowser({ chromium, profileDir: join(scratch, "app-browser-profile"), headless: false });
    return browser;
  },
  summarise: null,
  files: { roots: [], open: async () => undefined, titles: async () => [] },
  openApp: async () => ({ ok: false, said: "Not part of this check." }),
  notepad: (text, signal) => win["notepad.type"]({ text }, { signal }),
  deckBlank: (title, signal) => win["deck.blank"]({ title }, { signal }),
});
const registry = staticRegistry([defaultHub()]);
const service = createCommandService({ jobs: () => jobs, entry: () => entry, runs, hubDeviceId: "usman-pc", resolveTarget: (ctx) => resolveTarget(ctx, registry) });
const principal = { personId: "usman" as const, via: "loopback-owner" as const, actor: "human" as const, displayName: "Usman", deviceId: "usman-pc" };

const words = stamp.slice(11, 19).replace(/-/g, "");
const checks: Array<[string, string]> = [
  ["notepad", `Open Notepad and type 'M&U Track 2 real test line synthetic ${["amber", "cedar", "harbour", "willow"][Number(words) % 4]}'`],
  ["deck", "Open a new PowerPoint and add a title slide 'M&U Track 2 real test synthetic'"],
  ["web", "Open https://example.com"],
];
const results: unknown[] = [];
for (const [name, utterance] of checks) {
  if (only && only !== name) continue;
  const started = Date.now();
  const done = await service.run({ principal, body: { utterance, source: "typed" } });
  const job = done.jobId ? jobs.get(done.jobId) : null;
  const row = {
    label: "REAL",
    check: name,
    utterance,
    ok: done.ok,
    verified: done.verified ?? null,
    said: done.said,
    decision: done.decision ? { op: done.decision.op, policy: done.decision.policy, source: done.decision.source, deviceId: done.decision.deviceId } : null,
    job: job ? { id: job.id, state: job.state, kind: job.kind, targetDeviceId: job.targetDeviceId, steps: job.steps.map((s) => `${s.outcome}${s.verification ? `/${s.verification.ok}` : ""}: ${s.intent}`) } : null,
    ms: Date.now() - started,
  };
  results.push(row);
  console.log(JSON.stringify(row, null, 2));
}
await (browser as AppBrowser | null)?.close().catch(() => undefined);
deps.close?.();
console.log(JSON.stringify({ summary: results.map((r) => ({ check: (r as { check: string }).check, ok: (r as { ok: boolean }).ok, verified: (r as { verified: unknown }).verified })) }));
process.exit(0);
