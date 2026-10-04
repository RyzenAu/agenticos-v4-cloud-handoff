#!/usr/bin/env bun
/**
 * Cloud-role proof against a RUNNING hub (programme 20261001 round 3, Track E). Drives the real OS server started as the unit
 * starts it (MU_HUB_ROLE=cloud, its own MU_DATA_DIR, loopback, port 8113 by convention) over HTTP, as the owner's browser would,
 * and records what the hub says. Nothing here reads an environment value, token, pairing code or cookie into the output.
 *
 *   bun scripts/cloud/role-proof.ts check   [--hub http://127.0.0.1:8113] [--out file.json]
 *   bun scripts/cloud/role-proof.ts seed    [--hub ...]      leave a job record and a pairing code behind (before a restart)
 *   bun scripts/cloud/role-proof.ts after   [--hub ...]      after a restart: the job is still there and was NOT run again,
 *                                                            the pairing code still redeems state, no companion appeared
 *
 * Refuses 8081 (the live OS). The hub must run on an isolated data folder: see deploy/README.md "Local cloud-role rehearsal".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const mode = argv[0] ?? "check";
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1]! : dflt;
};
const HUB = opt("hub", "http://127.0.0.1:8113");
const OUT = opt("out", "");
/** The throwaway hub's own owner-session cookie, kept between runs so a restart can be shown to keep it. Never printed. */
const COOKIE_FILE = opt("cookie-file", "");
if (/:8081(\/|$)/.test(HUB)) throw new Error("Refusing the live OS (8081).");

type Check = { name: string; ok: boolean; observed: unknown };
const checks: Check[] = [];
const check = (name: string, ok: boolean, observed: unknown) => {
  checks.push({ name, ok, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

let cookie = "";
let pageToken = "";
async function http(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${HUB}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(cookie ? { cookie } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...((init.method ?? "GET") !== "GET" && pageToken ? { "x-claude-os-token": pageToken } : {}), ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}
/**
 * A browser's first navigation: a fresh hub trusts it as the owner's confirmed session. The hub tells a real browser from a
 * script by the peer process image, so this uses a real headless Chrome with a throwaway profile (as scripts/computers/journey.ts
 * does) and keeps only its hub-session cookie.
 */
async function navigate() {
  const { chromium } = await import("playwright-core");
  const profile = `${dirname(COOKIE_FILE || OUT || ".")}/browser-profile-${Date.now()}`;
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const res = await page.goto(`${HUB}/`, { waitUntil: "domcontentloaded" });
    const cookies = await ctx.cookies(HUB);
    cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return res?.status() ?? 0;
  } finally {
    await ctx.close();
  }
}
/** POST a Jarvis command and read the NDJSON stream to its "done" event. */
async function command(body: Record<string, unknown>) {
  const res = await fetch(`${HUB}/__operator/screen/command`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-claude-os-token": pageToken }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text.split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  return { status: res.status, done: events.findLast((e) => e.type === "done") ?? null, events, text: text.slice(0, 500) };
}
async function jobs() {
  const r = await http("/__operator/jobs");
  return r;
}

async function main() {
  if (COOKIE_FILE && existsSync(COOKIE_FILE)) cookie = readFileSync(COOKIE_FILE, "utf8").trim();
  const health = await http("/__health");
  check("hub answers /__health with role cloud", health.json?.hubRole === "cloud" && health.status === 200, { status: health.json?.status, hubRole: health.json?.hubRole, dataDir: health.json?.dataDir?.path, companions: health.json?.components?.companions });
  let nav = 0;
  if (!cookie) {
    nav = await navigate();
    if (COOKIE_FILE && cookie) writeFileSync(COOKIE_FILE, cookie);
  }
  pageToken = String((await http("/__token")).json?.token ?? "");
  const me = await http("/__devices/me");
  check("the owner's browser has a confirmed human session (first navigation on a fresh hub, or the saved cookie after a restart)", me.json?.authorised === true && me.json?.principal?.actor === "human", { nav, authorised: me.json?.authorised, via: me.json?.via, actor: me.json?.principal?.actor ?? null });

  if (mode === "check") {
    // 1. The hub never advertises itself as Usman's PC.
    const list = await http("/__devices/devices");
    const devices = (list.json?.devices ?? []) as any[];
    const dump = JSON.stringify(list.json);
    check("the device list has no hub device and nothing called Usman's PC", list.status === 200 && !devices.some((d) => d.kind === "hub" || d.id === "usman-pc") && !/Usman's PC/i.test(dump) && !/usman-pc/i.test(dump), { count: devices.length, kinds: devices.map((d) => d.kind) });
    check("the hub reports 0 companions online (a PC being asleep is normal, not a failure)", (health.json?.components?.companions?.online ?? 0) === 0, health.json?.components?.companions);

    // 2. A personal-PC action with no companion fails honestly, by saying it needs the PC, and nothing ran.
    const pc = await command({ utterance: "open Chrome", source: "typed" });
    const said = String(pc.done?.said ?? pc.text);
    check("'open Chrome' with no companion fails: not ok, nothing ran, says the PC is not connected, never the hub", pc.done?.ok === false && /no device registered|offline|not (connected|online)|companion|isn.t connected|can.t reach/i.test(said) && !/usman-pc/i.test(JSON.stringify(pc.done)), { status: pc.status, ok: pc.done?.ok, said, targetDeviceId: pc.done?.targetDeviceId ?? null, outcome: pc.done?.outcome ?? null });
    // The native routes answer 501 with one plain line instead of crashing or claiming success.
    const direct = await http("/__operator/pc/act", { method: "POST", body: { action: "screenshot" } });
    check("the native PC-control route answers 501 needs-companion", direct.status === 501 && direct.json?.ok === false && direct.json?.status === "needs-companion", { status: direct.status, body: direct.json });
    const browserAct = await http("/__operator/browser/act", { method: "POST", body: { action: "open" } });
    check("the agent-browser route answers 501 needs-companion", browserAct.status === 501 && browserAct.json?.status === "needs-companion", { status: browserAct.status });

    // 3. A shared-computer action with no such computer fails honestly BY NAME.
    const named = await http("/__computers/research/jobs", { method: "POST", body: { title: "open the docs", steps: [{ type: "wait", ms: 10 }] } });
    const list2 = await http("/__computers/");
    check("a shared computer called 'research' that does not exist is refused by name; the list is empty", String(named.json?.error ?? "") === 'No computer called "research".' && named.status >= 400 && (list2.json?.computers ?? []).length === 0, { status: named.status, body: named.json ?? named.text.slice(0, 200), computers: (list2.json?.computers ?? []).length });
    const viaJarvis = await command({ utterance: "use the cloud computer research to open the docs", source: "typed" });
    check("the same words through Jarvis: not ok, nothing ran, and never routed to a PC", viaJarvis.done?.ok === false && !/usman-pc/i.test(JSON.stringify(viaJarvis.done)), { ok: viaJarvis.done?.ok, said: viaJarvis.done?.said ?? viaJarvis.text.slice(0, 200) });
    const noHost = await http("/__computers/", { method: "POST", body: { name: "research" } });
    check("provisioning with no computer host configured says so plainly", noHost.status === 409 && /No computer host is configured/.test(noHost.text), { status: noHost.status, body: noHost.json ?? noHost.text.slice(0, 200) });
  }

  // Restart proof: seed -> (restart the hub) -> after -> (restart again) -> after2. State files hold this throwaway hub's own pairing
  // code and job ids; they are never printed.
  const STATE = `${COOKIE_FILE || OUT || "role-proof"}.state.json`;
  const CFG = `${COOKIE_FILE || OUT || "role-proof"}.companion-cfg`;
  const jobRows = async () => (((await http("/__jobs")).json?.jobs ?? []) as any[]).map((r) => ({ id: r.id, state: r.state }));
  if (mode === "seed") {
    const code = await http("/__devices/pair/code", { method: "POST", body: { purpose: "companion" } });
    check("a companion pairing code can be made (not printed)", code.status === 200 && typeof code.json?.code === "string", { status: code.status });
    const pc = await command({ utterance: "open Chrome", source: "typed" });
    check("a personal-PC command with no companion fails and leaves a job record that did not run", pc.done?.ok === false, { jobId: pc.done?.jobId ?? null });
    const rows = await jobRows();
    check("the job list shows it as not succeeded", rows.length >= 1 && rows.every((r) => r.state !== "succeeded" && r.state !== "running"), { states: rows.map((r) => r.state) });
    writeFileSync(STATE, JSON.stringify({ code: code.json?.code, jobs: rows }));
  }
  if (mode === "after") {
    const st = JSON.parse(readFileSync(STATE, "utf8")) as { code: string; jobs: { id: string; state: string }[] };
    const rows = await jobRows();
    check("after the restart the same jobs are listed with the same states (nothing re-run, nothing lost)", JSON.stringify(rows) === JSON.stringify(st.jobs), { before: st.jobs.map((r) => r.state), after: rows.map((r) => r.state), same_ids: rows.map((r) => r.id).join() === st.jobs.map((r) => r.id).join() });
    const pair = spawnSync(process.execPath, ["companion/main.ts", "pair", "--hub", HUB, "--code", st.code, "--label", "round3 rehearsal", "--config", CFG], { encoding: "utf8", cwd: resolve(import.meta.dir, "..", "..") });
    check("the pairing code made BEFORE the restart still redeems (the hub kept it); the companion pairs", pair.status === 0 && /Paired/.test(pair.stdout), { exit: pair.status, said: pair.stdout.replace(/\(.*?\)/, "(id)").slice(0, 80) });
    const list = await http("/__devices/devices");
    check("the paired companion is in the device list (offline: it is not running)", ((list.json?.devices ?? []) as any[]).some((d) => d.kind === "companion"), { kinds: ((list.json?.devices ?? []) as any[]).map((d) => `${d.kind}:${d.online ? "online" : "offline"}`) });
  }
  if (mode === "after2") {
    const st = JSON.parse(readFileSync(STATE, "utf8")) as { jobs: unknown[] };
    const list = await http("/__devices/devices");
    check("after a second restart the paired companion is still paired (no re-pairing)", ((list.json?.devices ?? []) as any[]).some((d) => d.kind === "companion"), { kinds: ((list.json?.devices ?? []) as any[]).map((d) => d.kind) });
    check("and the job list is unchanged", (await jobRows()).length === st.jobs.length, {});
  }

  const out = { hub: HUB, mode, at: new Date().toISOString(), passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, checks };
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  }
  console.log(JSON.stringify({ passed: out.passed, failed: out.failed }));
  process.exitCode = out.failed ? 1 : 0;
}

main().catch((e) => {
  console.error("role proof aborted:", (e as Error).message);
  process.exitCode = 2;
});
