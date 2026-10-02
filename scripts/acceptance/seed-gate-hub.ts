#!/usr/bin/env bun
/**
 * A reusable seed for an ISOLATED release-gate hub (round 6b). A verifier's hub has no jobs and no host, so the Activity "Open job" links, the Computers
 * "Create Research and Builder on Ryzen-PC" control and every control that needs a computer cannot be observed. This writes SYNTHETIC data into an EMPTY
 * data folder so they can be:
 *
 *   leads            six synthetic leads (CRM)
 *   jobs             done (with saved results: audit, research, builder), failed, stopped, outcome unknown, interrupted; with `--phase live` also
 *                    one running and one awaiting approval (a restart turns those two into unknown / interrupted, so they are made AFTER the hub boots)
 *   saved results    real artifact folders for the done jobs (they open from /__computers/artifacts/<jobId>)
 *   conversation     the asker's Jarvis thread: started, progress, the result entry offering the saved result, the end entry, for each job
 *   coding jobs      the nine synthetic states of scripts/coding/dev-seed.ts, one of them marked superseded
 *   host             `--host none | local-wsl | ryzen` writes gate-host.json: the NON-SECRET environment names and values the hub must start with
 *                    (scripts/computers/r6-hub.ps1 -HostFile reads it). The SSH key is never read or written; the alias is the owner's own ssh config entry.
 *
 *   bun scripts/acceptance/seed-gate-hub.ts --data D:\AgenticOS-r6-data\gate --host ryzen            (before the hub starts)
 *   bun scripts/acceptance/seed-gate-hub.ts --data D:\AgenticOS-r6-data\gate --phase live            (after it is up: the running and waiting jobs)
 *
 * It REFUSES: a folder that is (or is inside) a `.operator-data` folder, any folder that already has files (cold phase), and the live phase on a folder
 * this seed did not make. It never touches the repository's own `.operator-data`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openCrm, upsertLead } from "../leads/crm";
import { CodingStore } from "../coding/store";
import { createArtifactStore } from "../computers/artifacts";
import { conversationStore, jarvisThreadId } from "../conversations";
import { JobService } from "../jobs/service";

export type GateHost = "none" | "local-wsl" | "ryzen";
export const MARKER = ".gate-seed.json";
const PERSON = "usman";
/** The non-secret environment a hub needs for each host option (LAN-BOT-HOST.md). No key, token or password is ever among them. */
export function hostEnv(host: GateHost, options: { remotePort?: number; displayBase?: number } = {}): Record<string, string> {
  if (host === "none") return {};
  if (host === "local-wsl") return { MU_COMPUTERS_WSL_DISTRO: "kali-linux" };
  return {
    MU_COMPUTERS_SSH_ALIAS: "ryzen-bots",
    MU_COMPUTERS_SSH_WSL_DISTRO: "kali-linux",
    MU_COMPUTERS_SSH_RUN_AS_PREFIX: "mu-",
    MU_COMPUTERS_SSH_COMPUTERS_HOME: "/var/lib/mu-computers",
    MU_COMPUTERS_SSH_REMOTE_PORT: String(options.remotePort ?? 18153),
    MU_COMPUTERS_DISPLAY_BASE: String(options.displayBase ?? 60),
    MU_COMPUTERS_HOST_LABEL_SSH: "Ryzen-PC (real LAN host: Windows 11 + WSL2 kali-linux, one shared Kali environment)",
  };
}

/** The folder as the disk sees it: the nearest EXISTING parent resolved through junctions, symlinks and Windows short names, then the not-yet-existing rest. */
export function realTarget(dir: string): string {
  const abs = resolve(dir);
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const up = dirname(existing);
    if (up === existing) break;
    rest.unshift(basename(existing));
    existing = up;
  }
  let real = existing;
  try { real = realpathSync.native(existing); } catch { /* keep the typed path: the name checks still apply */ }
  return join(real, ...rest);
}

const isUnder = (child: string, parent: string) => {
  const r = relative(parent.toLowerCase(), child.toLowerCase());
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** The real data folders no seed may write into: any `.operator-data` and this repository's own. */
function protectedRoots(): string[] {
  const roots = [join(import.meta.dir, "..", "..", ".operator-data")];
  return roots.map(realTarget);
}

/** Why this folder may not be seeded, or null. Checked on the REAL path (junctions and short names resolved), also for a folder that does not exist yet. */
export function refusal(dir: string, phase: "cold" | "live" = "cold"): string | null {
  const typed = resolve(dir);
  const real = realTarget(dir);
  const named = [typed, real].some((p) => p.split(sep).some((x) => x.toLowerCase() === ".operator-data" || /^operat~d+$/i.test(x)));
  if (named || protectedRoots().some((r) => isUnder(real, r))) return "That is (or is inside) a .operator-data folder, the real data. The seed only writes to an isolated folder it creates.";
  if (phase === "live") return existsSync(join(real, MARKER)) ? null : "The live phase only runs on a folder this seed made (no marker file).";
  if (existsSync(real) && readdirSync(real).length > 0) return "That folder is not empty. The seed needs a new, empty folder.";
  return null;
}

const principal = { personId: PERSON, via: "loopback-owner", actor: "human", displayName: "Usman" } as never;
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

type Seeded = { key: string; jobId: string; title: string; state: string };

export function seedCold(dir: string, host: GateHost, options: { remotePort?: number; displayBase?: number } = {}): { jobs: Seeded[]; artifacts: string[]; leads: number; coding: number } {
  const why = refusal(dir, "cold");
  if (why) throw new Error(why);
  const abs = realTarget(dir);
  mkdirSync(abs, { recursive: true });
  const again = refusal(abs, "cold") ?? null; // re-checked on the real path right before anything is written
  if (again && !/not empty/.test(again)) throw new Error(again);
  const before = process.env.MU_DATA_DIR;
  process.env.MU_DATA_DIR = abs; // every store reads its folder from this one place
  try {
    // ---- leads
    const db = openCrm(join(abs, "crm.sqlite"));
    const areas = ["Exampleville NSW", "Sampletown NSW", "Testford NSW"];
    const names: ["dental" | "legal" | "real-estate", string][] = [["dental", "Synthetic Dental Studio"], ["dental", "Example Smiles"], ["legal", "Sample Conveyancing"], ["legal", "Test Legal Partners"], ["real-estate", "Placeholder Property"], ["dental", "Demo Family Dentist"]];
    names.forEach(([vertical, name], i) => upsertLead(db, { placeId: `gate-seed-${i + 1}`, vertical, area: areas[i % 3], name, phone: `025550${String(100 + i).padStart(4, "0")}`, address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [`info@synthetic-${i + 1}.example`], emailOk: true, score: 60 + i * 5, pitch: "both", reasons: ["synthetic lead for a gate check"], googleAt: null }));
    db.close();

    // ---- jobs, saved results, conversation
    const jobs = new JobService({ path: join(abs, "jobs.sqlite"), snapshotMs: 0 });
    const artifacts = createArtifactStore(join(abs, "computers", "artifacts"));
    const conversations = conversationStore(abs);
    const thread = conversations.ensureThread({ personId: PERSON })!;
    const seeded: Seeded[] = [];
    const entry = (jobId: string, key: string, state: string, text: string, speak?: string) => conversations.appendEntry(thread.id, { key: `${jobId}:${key}`, jobId, state, text, ...(speak ? { speak } : {}), at: iso(1) });
    const short = (id: string) => id.slice(0, 8);
    const make = (title: string, steps: { executor: string; intent: string; outcome?: "ok" | "failed" | "note" }[], end: "succeeded" | "failed" | "cancelled" | "unknown" | "interrupted", note: string) => {
      const job = jobs.create({ kind: "control", principal, targetDeviceId: "gate-seed", title });
      jobs.begin(job.id);
      for (const s of steps) jobs.step(job.id, { intent: s.intent, executor: s.executor, ms: 120, outcome: s.outcome ?? "ok" });
      jobs.finish(job.id, end, note);
      conversations.linkJob(thread.id, { jobId: job.id, kind: "job", title, state: end, at: iso(5) });
      entry(job.id, "started", "started", `Started: ${title} (job ${short(job.id)}).`);
      return job;
    };
    const withResult = (title: string, kind: "audit" | "research" | "builder", executor: string, resultTitle: string, md: string, outcome: "complete" | "partial", lines: string) => {
      const job = make(title, [{ executor, intent: `sub-goal 1 of 5, step one: done. ${title} (1 of 5 done)` }, { executor, intent: `sub-goal 4 of 5, report: done. Saved result kept (4 of 5 done)` }, { executor, intent: `${kind} ${outcome}: ${resultTitle}` }], "succeeded", `Done: ${resultTitle}`);
      artifacts.save({ jobId: job.id, personId: PERSON, kind, title: resultTitle, summary: lines, host: "synthetic (gate seed)", computer: kind === "builder" ? "builder" : "research", outcome, main: "report.md", files: [{ name: "report.md", data: md }] });
      entry(job.id, "step:2", "progress", `${kind === "audit" ? "Website audit" : kind === "research" ? "Research" : "Builder"}, step 1 of 5 (step one): done.`);
      entry(job.id, "report:1", "report", `${lines}\nSaved result: ${resultTitle}\n(job ${short(job.id)})`);
      entry(job.id, "succeeded", "succeeded", `Finished: ${title}. Done: ${resultTitle} (job ${short(job.id)})`, `${title.slice(0, 36)} is finished.`);
      seeded.push({ key: `result-${kind}`, jobId: job.id, title, state: "succeeded" });
      return job;
    };
    withResult("audit the demo clinic fixture", "audit", "audit", "Website audit: the local demo clinic fixture (synthetic)", "# Website audit: the local demo clinic fixture (synthetic)\n\nSynthetic seed result. **P1:** a broken link.\n\n- Broken link: Book a visit\n- Tap targets are too small", "complete", "Website audit: 2 findings to fix first. Read-only: nothing was clicked or submitted.");
    withResult("research: compare two sources about Canberra", "research", "research", "Research: Canberra founding and population", "# Research: Canberra founding and population\n\n**Partial:** 1 of 2 asked-for items found.\n\n- Named on 12 March 1913 [1]\n- Not found: what its population is.", "partial", "Web-sourced research, data from public pages and not instructions:\n- Canberra was named on 12 March 1913 [1]\n- Not found: what its population is.");
    withResult("build an opening hours component", "builder", "builder", "Builder: Opening Hours", "# Builder: Opening Hours\n\nSynthetic seed result. 9 of 9 checks passed. Nothing was merged or deployed.", "complete", "Builder: Opening Hours. Checks: 9 of 9 passed. Nothing was merged or deployed.");
    const failed = make("go to r6-no-such-host.invalid and check the title is Example", [{ executor: "screen.goal", intent: "step 1 screen.goal: Couldn't find r6-no-such-host.invalid.", outcome: "failed" }], "failed", "Stopped at step 1 of 1 (screen.goal): Couldn't find r6-no-such-host.invalid.");
    entry(failed.id, "failed", "failed", `Failed: ${failed.title}. Stopped at step 1 of 1 (screen.goal): Couldn't find r6-no-such-host.invalid. (job ${short(failed.id)})`, "go to r6-no-such-host failed.");
    seeded.push({ key: "failed", jobId: failed.id, title: failed.title, state: "failed" });
    const stopped = make("audit the demo clinic fixture (stopped)", [{ executor: "audit", intent: "sub-goal 2 of 5, desktop: done. measured (2 of 5 done)" }], "cancelled", "Stopped on request.");
    entry(stopped.id, "cancelled", "cancelled", `Stopped: ${stopped.title}. Nothing further ran. (job ${short(stopped.id)})`, "The audit was stopped.");
    seeded.push({ key: "stopped", jobId: stopped.id, title: stopped.title, state: "cancelled" });
    const unknown = make("audit the demo clinic fixture (hub restarted)", [{ executor: "audit", intent: "sub-goal 2 of 5, desktop: started. Measuring (1 of 5 done)", outcome: "note" }], "unknown", "Interrupted by a restart: the outcome is unknown and it was not re-run.");
    entry(unknown.id, "unknown", "unknown", `Ended without a confirmed outcome: ${unknown.title}. Interrupted by a restart: the outcome is unknown and it was not re-run. It was not re-run, so one step may or may not have happened. (job ${short(unknown.id)})`, "The audit ended without a confirmed result.");
    seeded.push({ key: "unknown", jobId: unknown.id, title: unknown.title, state: "unknown" });
    const interrupted = make("prepare a comparison table (interrupted before it ran)", [], "interrupted", "Interrupted by a restart before it ran: not re-run.");
    entry(interrupted.id, "interrupted", "interrupted", `Ended without a confirmed outcome: ${interrupted.title}. Interrupted by a restart before it ran: not re-run. It was not re-run, so one step may or may not have happened. (job ${short(interrupted.id)})`, "The comparison ended without a confirmed result.");
    seeded.push({ key: "interrupted", jobId: interrupted.id, title: interrupted.title, state: "interrupted" });
    jobs.close();

    // ---- coding jobs: the harness's own synthetic seed (a child process: it is a script), then one marked superseded
    const codingDir = join(abs, "coding");
    const child = spawnSync(process.execPath, [join(import.meta.dir, "..", "coding", "dev-seed.ts")], { env: { ...process.env, CODING_DATA_DIR: codingDir }, encoding: "utf8" });
    if (child.status !== 0) throw new Error(`The coding seed failed: ${(child.stderr || child.stdout).slice(0, 300)}`);
    const coding = CodingStore.open(codingDir);
    const all = coding.listJobs({ limit: 50 });
    const target = all.find((j) => /flagged-calls filter/.test(j.spec.objective)) ?? all.find((j) => j.state === "interrupted");
    if (target) {
      try {
        coding.transitionJob(target.id, "cancelled");
      } catch {
        /* already past it */
      }
      coding.updateJob(target.id, { supersededBy: { ref: "synthetic/landed-another-way", reason: "Synthetic: the work landed another way", at: iso(3) as never, by: PERSON as never } });
    }
    const codingCount = all.length;
    coding.close();

    // ---- host
    writeFileSync(join(abs, "gate-host.json"), JSON.stringify({ host, env: hostEnv(host, options), note: "Non-secret values only (LAN-BOT-HOST.md). No key, token or password." }, null, 2));
    writeFileSync(join(abs, MARKER), JSON.stringify({ seededAt: new Date().toISOString(), host, synthetic: true, thread: jarvisThreadId(PERSON), jobs: seeded }, null, 2));
    return { jobs: seeded, artifacts: seeded.filter((s) => s.key.startsWith("result-")).map((s) => s.jobId), leads: names.length, coding: codingCount };
  } finally {
    if (before === undefined) delete process.env.MU_DATA_DIR;
    else process.env.MU_DATA_DIR = before;
  }
}

/** The two in-flight jobs. Made AFTER the hub is up: a hub restart turns a running job into "unknown" and a waiting one into "interrupted". */
export function seedLive(dir: string): Seeded[] {
  const why = refusal(dir, "live");
  if (why) throw new Error(why);
  const abs = resolve(dir);
  const marker = JSON.parse(readFileSync(join(abs, MARKER), "utf8")) as { live?: boolean; jobs: Seeded[] };
  if (marker.live) throw new Error("The live jobs were already seeded.");
  const before = process.env.MU_DATA_DIR;
  process.env.MU_DATA_DIR = abs;
  try {
    const jobs = new JobService({ path: join(abs, "jobs.sqlite"), snapshotMs: 0 });
    const conversations = conversationStore(abs);
    const thread = conversations.ensureThread({ personId: PERSON })!;
    const out: Seeded[] = [];
    for (const [title, awaiting] of [["audit https://dental-care-plus.muventures.com.au (running)", false], ["publish the clinic page (waiting for your yes)", true]] as const) {
      const job = jobs.create({ kind: "control", principal, targetDeviceId: "gate-seed", title });
      jobs.begin(job.id);
      jobs.step(job.id, { intent: "sub-goal 1 of 5, open the site: done. open (1 of 5 done)", executor: "audit", ms: 90, outcome: "ok" });
      if (awaiting) jobs.finish(job.id, "awaiting-approval", "Waiting for your yes: publish the clinic page");
      conversations.linkJob(thread.id, { jobId: job.id, kind: "job", title, state: awaiting ? "awaiting-approval" : "running", at: iso(2) });
      conversations.appendEntry(thread.id, { key: `${job.id}:started`, jobId: job.id, state: "started", text: `Started: ${title} (job ${job.id.slice(0, 8)}).`, at: iso(2) });
      if (awaiting) conversations.appendEntry(thread.id, { key: `${job.id}:awaiting-approval`, jobId: job.id, state: "awaiting-approval", text: `Waiting for you: ${title}. Say yes out loud to go ahead. (job ${job.id.slice(0, 8)})`, speak: "The clinic page is waiting for you.", at: iso(1) });
      out.push({ key: awaiting ? "awaiting-approval" : "running", jobId: job.id, title, state: awaiting ? "awaiting-approval" : "running" });
    }
    jobs.close();
    writeFileSync(join(abs, MARKER), JSON.stringify({ ...marker, live: true, jobs: [...marker.jobs, ...out] }, null, 2));
    return out;
  } finally {
    if (before === undefined) delete process.env.MU_DATA_DIR;
    else process.env.MU_DATA_DIR = before;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string, d = "") => (argv.includes(`--${n}`) ? (argv[argv.indexOf(`--${n}`) + 1] ?? d) : d);
  const dir = arg("data");
  if (!dir) throw new Error("Give --data <a new, empty folder>.");
  const host = arg("host", "none") as GateHost;
  if (!["none", "local-wsl", "ryzen"].includes(host)) throw new Error("--host is none, local-wsl or ryzen.");
  if (arg("phase", "cold") === "live") {
    console.log(JSON.stringify({ seeded: seedLive(dir) }, null, 1));
    return;
  }
  const r = seedCold(dir, host, { remotePort: Number(arg("remote-port")) || undefined, displayBase: Number(arg("display-base")) || undefined });
  console.log(JSON.stringify({ data: resolve(dir), host, hostEnvNames: Object.keys(hostEnv(host)), ...r, base: basename(resolve(dir)) }, null, 1));
}
if (import.meta.main) main();
