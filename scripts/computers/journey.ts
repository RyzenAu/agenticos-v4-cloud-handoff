#!/usr/bin/env bun
/**
 * The real journey for shared cloud computers (programme 20261001, Agent F): a real cloud-role hub (its own port and data folder),
 * a real browser session, two real computers ("research" and "builder") on a WSL host, two agent jobs at once, a human takeover and
 * return, a stop, and a crash with recovery. It prints evidence (states, timings, what ran) and NEVER a cookie, token, pairing code
 * or environment value.
 *
 *   bun scripts/computers/journey.ts --hub http://127.0.0.1:8112 --out D:\prog-scratch\journey [--distro kali-linux] [--keep]
 *
 * The hub must already be running with MU_HUB_ROLE=cloud, MU_COMPUTERS_WSL_DISTRO=<distro> and its own MU_DATA_DIR (see
 * docs/programme-20261001/COMPUTERS-EVIDENCE.md). The browser is a headless Chrome with a throwaway profile: a fresh hub
 * trusts its first navigation as a confirmed human session, exactly as it does for the owner's own browser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultRunner } from "./wsl-local";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const hub = arg("hub", "http://127.0.0.1:8112")!;
const out = arg("out", "D:\\prog-scratch\\journey")!;
const distro = arg("distro", "kali-linux")!;
const keep = argv.includes("--keep");
mkdirSync(out, { recursive: true });

const evidence: { at: string; step: string; ms?: number; data: unknown }[] = [];
const t0 = Date.now();
const log = (step: string, data: unknown, ms?: number) => {
  evidence.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, step, ...(ms !== undefined ? { ms } : {}), data });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}${ms !== undefined ? ` (${ms} ms)` : ""}: ${JSON.stringify(data).slice(0, 400)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a short command inside the distro (read-only checks, and the deliberate crash). */
async function wsl(command: string) {
  const r = await defaultRunner(["wsl.exe", "-d", distro, "--", "bash", "-s"], { stdin: command, timeoutMs: 30_000 });
  return r.stdout.trim();
}

let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;

async function main() {
  browser = await chromium.launchPersistentContext(join(out, "browser-profile"), { channel: "chrome", headless: true });
  const page: Page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto(`${hub}/`, { waitUntil: "domcontentloaded" });
  const me = await page.evaluate(async () => (await (await fetch("/__devices/me")).json()) as any);
  log("browser session", { authorised: me.authorised, via: me.via, actor: me.principal?.actor, person: me.person?.id });
  if (me.principal?.actor !== "human") throw new Error("This hub did not treat the browser as a confirmed human session; use a fresh data folder.");
  const token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
  const health = await page.evaluate(async () => (await (await fetch("/__health")).json()) as any);
  log("hub health", { ok: health.ok, hubRole: health.hubRole, companions: health.companions });

  const api = async (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ([m, p, b, t]) => {
        const res = await fetch(`/__computers${p}`, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
        return { status: res.status, json: await res.json().catch(() => ({})) };
      },
      [method, path, body ?? null, token] as unknown[] as [string, string, unknown, string],
    ) as Promise<{ status: number; json: any }>;
  const list = async () => ((await api("GET", "/")).json.computers as any[]) ?? [];
  const view = async (name: string) => (await list()).find((c) => c.name === name);
  const waitFor = async (what: string, fn: () => Promise<any>, ms = 60_000, every = 250) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(every);
    }
  };
  const job = async (id: string) => (await api("GET", `/jobs/${id}`)).json.job as any;
  const settled = (state: string) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(state);

  // 0. A clean slate: remove computers of these names a previous run left.
  for (const c of await list()) if (["research", "builder"].includes(c.name)) log(`reset: removing the old "${c.name}" computer`, { status: (await api("POST", `/${c.name}/action`, { action: "destroy" })).status });

  // 1. What the host has.
  const host = (await api("GET", "/host")).json;
  log("host check", host.adapters?.map((a: any) => ({ kind: a.kind, ok: a.check.ok, present: a.check.present, missing: a.check.missing, installCommand: a.check.installCommand, notes: a.check.notes })));
  const desktop = !host.adapters?.[0]?.check?.missing?.some((m: string) => m === "Xvfb" || m === "chromium");

  // 2. Provision two computers.
  for (const name of ["research", "builder"]) {
    const t = Date.now();
    const r = await api("POST", "/", { name });
    log(`provision ${name}`, { status: r.status, ...(r.status === 200 ? { state: r.json.computer.state, id: r.json.computer.id, kind: r.json.computer.kind, owner: r.json.computer.owner, desktop: r.json.computer.desktop } : r.json) }, Date.now() - t);
    if (r.status !== 200) throw new Error(`provisioning ${name} failed`);
  }
  await waitFor("both computers online", async () => (await list()).length === 2 && (await list()).every((c) => c.state === "online"));
  await sleep(11_000); // one monitor probe: resource readings
  log("both online", (await list()).map((c) => ({ name: c.name, state: c.state, kind: c.kind, owner: c.owner, capabilities: c.capabilities?.length, resource: c.resource, viewer: c.viewer })));

  const folders = await wsl('B="$HOME/mu-computers"; for c in research builder; do echo "$c: display=$(grep -o \'"display": *"[0-9]*"\' $B/$c/cfg/computer.json) workdir=$B/$c/work pid=$(cut -d" " -f1 $B/$c/run/companion.pid) sid=$(ps -o sid= -p $(cut -d" " -f1 $B/$c/run/companion.pid) | tr -d " ")"; done');
  log("isolated per-computer folders and processes (inside WSL)", folders.split("\n"));

  // 3. Two agents at once, each on its own computer.
  // With the desktop packages installed, each computer also opens its OWN Chromium on a different public page and checks the title.
  const pages: Record<string, { url: string; title: string }> = { research: { url: "https://example.com", title: "Example Domain" }, builder: { url: "https://www.wikipedia.org", title: "Wikipedia" } };
  const steps = (tag: string) => [
    { executor: "computer.info" },
    ...(desktop ? [{ executor: "browser.navigate", args: { url: pages[tag].url, expectTitle: pages[tag].title }, timeoutMs: 45_000 }] : []),
    { executor: "file.write", args: { name: "findings.txt", text: `${tag} notes` } },
    { executor: "wait", args: { ms: 6000 } },
    { executor: "file.read", args: { name: "findings.txt" } },
  ];
  const t1 = Date.now();
  const [ja, jb] = await Promise.all([
    api("POST", "/research/jobs", { agent: "researcher", title: "Research agent", steps: steps("research") }),
    api("POST", "/builder/jobs", { agent: "builder-agent", title: "Builder agent", steps: steps("builder") }),
  ]);
  log("two jobs started", { research: ja.json.jobId ? "started" : ja.json, builder: jb.json.jobId ? "started" : jb.json }, Date.now() - t1);
  await sleep(2_500);
  log("both computers busy at once", (await list()).map((c) => ({ name: c.name, state: c.state, controller: c.controller, assigned: c.assigned && { agent: c.assigned.agent, by: c.assigned.by } })));
  await waitFor("both jobs settled", async () => settled((await job(ja.json.jobId)).state) && settled((await job(jb.json.jobId)).state), 90_000);
  const [ra, rb] = [await job(ja.json.jobId), await job(jb.json.jobId)];
  log("concurrent jobs finished", {
    wallMs: Date.now() - t1,
    research: { state: ra.state, note: ra.note, steps: ra.steps.map((s: any) => `${s.outcome} ${s.action}: ${s.intent.slice(0, 70)}`) },
    builder: { state: rb.state, note: rb.note, steps: rb.steps.map((s: any) => `${s.outcome} ${s.action}: ${s.intent.slice(0, 70)}`) },
  });
  if (desktop) {
    for (const name of ["research", "builder"]) {
      const shot = await page.evaluate(async (n) => {
        const res = await fetch(`/__computers/${n}/screenshot`);
        return { status: res.status, type: res.headers.get("content-type"), bytes: (await res.arrayBuffer()).byteLength };
      }, name);
      log(`snapshot of ${name}'s browser (in memory, never on disk)`, shot);
    }
  }
  log("each computer wrote its own file (same name, separate working folders)", (await wsl('B="$HOME/mu-computers"; for c in research builder; do echo "$c: $(cat $B/$c/work/findings.txt)"; done')).split("\n"));

  // 4. A person takes control of research mid-job, acts, and returns it.
  const timeline: unknown[] = [];
  const mark = async (what: string) => {
    const v = await view("research");
    timeline.push({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, what, state: v.state, controller: v.controller.kind && `${v.controller.kind}:${v.controller.who}`, takeoverPending: !!v.takeoverPending, paused: v.paused?.agent ?? null });
  };
  const jt = await api("POST", "/research/jobs", {
    agent: "researcher",
    title: "Research agent (will be taken over)",
    steps: [{ executor: "wait", args: { ms: 7000 } }, { executor: "file.write", args: { name: "after-return-1.txt", text: "agent step 2" } }, { executor: "file.write", args: { name: "after-return-2.txt", text: "agent step 3" } }],
  });
  await sleep(1_500);
  await mark("agent running step 1 (a 7 s wait)");
  const take = await api("POST", "/research/takeover", {});
  log("takeover requested mid-step", { status: take.status, state: take.json.state });
  await mark("takeover pending: the agent is not interrupted");
  await waitFor("the agent to pause at the step boundary", async () => (await view("research")).controller.kind === "person", 30_000);
  await mark("paused at the boundary: the person holds the computer");
  const human = await api("POST", "/research/input", { executor: "file.write", args: { name: "human.txt", text: "written by a person during the takeover" } });
  log("person acted while holding the lease", { status: human.status, said: human.json.result?.said });
  log("the files at this moment (the agent's later steps have not run)", (await wsl('ls "$HOME/mu-computers/research/work"')).split("\n"));
  const renew = await api("POST", "/research/lease/renew", {});
  log("viewer heartbeat keeps control", { ok: renew.json.ok });
  const back = await api("POST", "/research/return", {});
  log("returned to agent", { status: back.status, resumedJob: back.json.resumed === jt.json.jobId ? "the same job" : back.json.resumed });
  await waitFor("the job to finish", async () => settled((await job(jt.json.jobId)).state), 60_000);
  const rt = await job(jt.json.jobId);
  log("job after return", { state: rt.state, note: rt.note, steps: rt.steps.map((s: any) => `${s.outcome} ${s.action ?? ""}: ${s.intent.slice(0, 90)}`) });
  log("lease timeline", timeline);
  log("files after the agent resumed", (await wsl('ls "$HOME/mu-computers/research/work"')).split("\n"));

  // 4b. An abandoned viewer never locks a computer.
  const grab = await api("POST", "/builder/takeover", {});
  const grabbedAt = Date.now();
  log("viewer takes idle builder", { state: grab.json.state });
  await waitFor("the abandoned lease to expire", async () => (await view("builder")).controller.kind === null, 150_000);
  log("abandoned viewer expired and freed the computer", { afterMs: Date.now() - grabbedAt, state: (await view("builder")).state });

  // 5. A stop.
  const js = await api("POST", "/research/jobs", { agent: "researcher", title: "Research agent (will be stopped)", steps: [{ executor: "wait", args: { ms: 60000 } }, { executor: "file.write", args: { name: "never.txt", text: "must not exist" } }] });
  await sleep(2_000);
  const tStop = Date.now();
  const stop = await api("POST", `/jobs/${js.json.jobId}/cancel`, {});
  await waitFor("the job to settle after the stop", async () => settled((await job(js.json.jobId)).state), 30_000);
  const rs = await job(js.json.jobId);
  log("stop", { status: stop.status, state: rs.state, afterMs: Date.now() - tStop, steps: rs.steps.map((s: any) => `${s.outcome}: ${s.intent.slice(0, 70)}`), neverWritten: !(await wsl('test -e "$HOME/mu-computers/research/work/never.txt" && echo yes || echo no')).includes("yes"), computer: (await view("research")).state });

  // 6. A crash and recovery (the companion dies while its step is running).
  const before = await view("builder");
  const jc = await api("POST", "/builder/jobs", { agent: "builder-agent", title: "Builder agent (its computer will crash)", steps: [{ executor: "wait", args: { ms: 40000 } }, { executor: "file.write", args: { name: "after-crash.txt", text: "must not run" } }] });
  await sleep(2_500);
  const ledgerBefore = await wsl('cat "$HOME/mu-computers/builder/cfg/command-ledger.json" | grep -o \'"state": *"[a-z]*"\' | sort | uniq -c');
  const killedAt = Date.now();
  await wsl('kill -9 $(cut -d" " -f1 "$HOME/mu-computers/builder/run/companion.pid"); pkill -9 -f "user-data-dir=$HOME/mu-computers/builder/profile"; echo killed');
  const states: { at: string; state: string; failure?: string | null; recoveries: number }[] = [];
  let last = "";
  const recovered = await waitFor("failed, then recovered", async () => {
    const v = await view("builder");
    if (v.state !== last) {
      last = v.state;
      states.push({ at: `+${((Date.now() - killedAt) / 1000).toFixed(1)}s after the kill`, state: v.state, failure: v.failure?.reason ?? null, recoveries: v.recoveries });
    }
    return states.some((s) => s.state === "failed") && v.state === "online" && v.recoveries >= 1;
  }, 120_000, 100);
  void recovered;
  log("state timeline after the kill", states);
  await waitFor("the crashed job to settle", async () => settled((await job(jc.json.jobId)).state), 60_000);
  const rc = await job(jc.json.jobId);
  const after = await view("builder");
  log("crashed job and recovery", {
    jobState: rc.state, jobNote: rc.note, steps: rc.steps.map((s: any) => `${s.outcome}: ${s.intent.slice(0, 90)}`),
    sameDevice: before.id === after.id, recoveries: after.recoveries,
    laterStepRan: (await wsl('test -e "$HOME/mu-computers/builder/work/after-crash.txt" && echo yes || echo no')).includes("yes"),
    ledgerBefore: ledgerBefore.split("\n"),
    ledgerAfter: (await wsl('cat "$HOME/mu-computers/builder/cfg/command-ledger.json" | grep -o \'"state": *"[a-z]*"\' | sort | uniq -c')).split("\n"),
  });
  const follow = await api("POST", "/builder/jobs", { agent: "builder-agent", title: "Builder agent (after recovery)", steps: [{ executor: "file.write", args: { name: "post-recovery.txt", text: "works again" } }] });
  await waitFor("the post-recovery job", async () => settled((await job(follow.json.jobId)).state), 30_000);
  log("the recovered computer takes work again", { state: (await job(follow.json.jobId)).state });
  log("lifecycle log (no secrets)", ((await api("GET", "/events")).json.events as any[]).map((e) => `${e.computer}: ${e.type}${e.detail ? ` (${e.detail})` : ""}`));

  // 7. Resource use, then tear everything down.
  log("resource use per computer (measured inside WSL by the hub's own probe)", (await list()).map((c) => ({ name: c.name, resource: c.resource, desktop: c.desktop })));
  log("what a person would see: desktop packages", { desktop, note: desktop ? "a desktop is available" : "this host has no Xvfb/chromium, so the computers ran headless; the snapshot and VNC viewer paths are proven in tests only" });
  if (!keep) {
    for (const name of ["research", "builder"]) log(`destroy ${name}`, { status: (await api("POST", `/${name}/action`, { action: "destroy" })).status });
    log("nothing left inside WSL", (await wsl('B="$HOME/mu-computers"; ls "$B" 2>/dev/null; pgrep -fa "mu-computers" | grep -v pgrep | head -3; rm -rf "$B"; echo cleaned')).split("\n"));
  }
  await browser.close();
  browser = null;
}

main()
  .catch((error) => {
    log("FAILED", String(error?.message ?? error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => undefined);
    writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  });
