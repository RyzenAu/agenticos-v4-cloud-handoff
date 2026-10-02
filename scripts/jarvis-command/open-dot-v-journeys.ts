#!/usr/bin/env bun
/**
 * Open Dot V real journeys (programme 20261001, builder V): speak/type to Jarvis -> one identifiable job on the ONE command path -> work
 * continues after the client is gone -> the result is in the SAME conversation when the person comes back.
 *
 * Everything is isolated and owned by this script: a cloud-role hub (own port, own data folder on D:, HINDSIGHT_URL=off, MU_MEMORY_WRITES=off),
 * ONE shared computer "v-research" provisioned through the existing computers API (WSL host allocator), a headless Chrome profile of its
 * own for the "client", and (journey b) a throwaway git repo under D:/prog-scratch. It never prints a cookie, token, pairing code, key or
 * environment value, and kills only the processes it started (the hub by PID tree; the computer through the API's own destroy).
 *
 *   bun scripts/jarvis-command/open-dot-v-journeys.ts up                  start the hub (writes <out>/hub.pid)
 *   bun scripts/jarvis-command/open-dot-v-journeys.ts a                   provision v-research, "research ..." by voice, CLOSE the client mid-job, reopen, read the result
 *   bun scripts/jarvis-command/open-dot-v-journeys.ts b                   coding task on claude:max-2 in a throwaway repo (one bounded real run), result in the conversation
 *   bun scripts/jarvis-command/open-dot-v-journeys.ts c                   replay the same utterance event after a reconnect: still one job
 *   bun scripts/jarvis-command/open-dot-v-journeys.ts d                   two active jobs: "how's that going?" answers the right one
 *   bun scripts/jarvis-command/open-dot-v-journeys.ts f                   cancel: "stop that task" -> no later step executes
 *   bun scripts/jarvis-command/open-dot-v-journeys.ts down                destroy v-research (API), stop the hub (by PID tree)
 * Flags: --out D:\prog-scratch\open-dot-v  --port 8111  --data D:\prog-open-dot-v-data  --distro kali-linux
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const out = arg("out", "D:\\prog-scratch\\open-dot-v");
const port = Number(arg("port", "8111"));
const data = arg("data", "D:\\prog-open-dot-v-data");
const distro = arg("distro", "kali-linux");
const repo = resolve(import.meta.dir, "..", "..");
const hubUrl = `http://127.0.0.1:${port}`;
const COMPUTER = "v-research";
const scratchRepo = "D:/prog-scratch/open-dot-v-repo";
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (step: string, d: unknown) => {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}: ${JSON.stringify(d).slice(0, 1500)}`;
  console.log(line);
  appendFileSync(join(out, "evidence.log"), `${new Date().toISOString()} ${line}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- hub lifecycle (owned) ------------------------------------------------------------------------------------------------------------
async function up() {
  if (existsSync(join(out, "hub.pid"))) return log("hub already recorded", { pid: Number(readFileSync(join(out, "hub.pid"), "utf8")) });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(data, "coding"), { recursive: true });
  // The coding harness reads its own account map (slot -> sign-in folder) and repo registry from CODING_DATA_DIR. The account map is copied byte for byte
  // (never read or printed here); the registry names ONLY the throwaway repo.
  const live = "C:/Users/Nebula PC/source/repos/AgenticOS-v4/.operator-data/coding/accounts.json";
  if (existsSync(live)) copyFileSync(live, join(data, "coding", "accounts.json"));
  const logFd = openSync(join(out, "hub.log"), "a");
  const child = spawn(process.execPath, ["--bun", "node_modules/vite/bin/vite.js", "dev", "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
    cwd: repo,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    detached: true,
    env: {
      ...process.env,
      MU_HUB_ROLE: "cloud", MU_DATA_DIR: data, HINDSIGHT_URL: "off", MU_MEMORY_WRITES: "off",
      CODING_DATA_DIR: join(data, "coding"),
      MU_COMPUTERS_WSL_DISTRO: distro, MU_COMPUTERS_DISPLAY_BASE: "441", MU_COMPUTERS_HOME: "/home/ryzen/mu-computers-v", WSLENV: "MU_COMPUTERS_HOME",
      MU_COMPUTERS_MONITOR_MS: "5000", MU_COMPUTERS_PERSON_LEASE_MS: "30000",
    },
  });
  writeFileSync(join(out, "hub.pid"), String(child.pid));
  child.unref();
  const end = Date.now() + 120_000;
  for (;;) {
    try {
      await fetch(`${hubUrl}/__health`);
      break;
    } catch {
      if (Date.now() > end) throw new Error("the hub did not start");
      await sleep(500);
    }
  }
  log("hub up", { pid: child.pid, port, role: "cloud", dataDirOnD: data.startsWith("D:") });
}

// ---- the "client": a headless Chrome profile that can be closed and reopened ---------------------------------------------------------------
type Client = { page: Page; close: () => Promise<void>; call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>; command: (body: Record<string, unknown>, opts?: { abortAfterMs?: number }) => Promise<{ events: any[]; done: any | null; aborted: boolean }> };
async function client(): Promise<Client> {
  const ctx = await chromium.launchPersistentContext(join(out, "client-profile"), { channel: "chrome", headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${hubUrl}/`, { waitUntil: "domcontentloaded" });
  const me = await page.evaluate(async () => (await (await fetch("/__devices/me")).json()) as any);
  if (me.principal?.actor !== "human") throw new Error("the hub did not treat the browser as a confirmed human session");
  const token = await page.evaluate(async () => (await (await fetch("/__token")).json()).token as string);
  const call: Client["call"] = (method, path, body) =>
    page.evaluate(
      async ([m, p, b, t]) => {
        const res = await fetch(p as string, { method: m as string, headers: { "content-type": "application/json", ...(m !== "GET" ? { "x-claude-os-token": t as string } : {}) }, body: b == null ? undefined : JSON.stringify(b) });
        const text = await res.text();
        let json: any = {};
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json };
      },
      [method, path, body ?? null, token] as unknown[] as [string, string, unknown, string],
    );
  const command: Client["command"] = (body, opts = {}) =>
    page.evaluate(
      async ([b, t, abortAfterMs]) => {
        const controller = new AbortController();
        if (abortAfterMs) setTimeout(() => controller.abort(), abortAfterMs as number);
        const events: any[] = [];
        let aborted = false;
        try {
          const res = await fetch("/__operator/screen/command", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", "x-claude-os-token": t as string }, body: JSON.stringify(b) });
          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (line) events.push(JSON.parse(line));
            }
          }
        } catch {
          aborted = true;
        }
        return { events, done: events.find((e) => e.type === "done") ?? null, aborted };
      },
      [body, token, opts.abortAfterMs ?? 0] as unknown[] as [Record<string, unknown>, string, number],
    );
  return { page, call, command, close: () => ctx.close() };
}

const settled = (s: string) => ["succeeded", "failed", "cancelled", "interrupted", "unknown"].includes(s);
async function waitFor<T>(what: string, fn: () => Promise<T | null | false>, ms = 120_000, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
const thread = async (c: Client) => {
  const list = (await c.call("GET", "/__operator/conversations")).json.conversations as any[] | undefined;
  return (list ?? []).find((x) => x.thread === "jarvis") ?? null;
};
const brief = (c: any) => c && { id: c.id, title: c.title, jobs: (c.jobs ?? []).map((j: any) => ({ jobId: j.jobId.slice(0, 8), kind: j.kind, state: j.state, title: j.title, context: j.context })), messages: (c.messages ?? []).map((m: any) => `${m.role}${m.via ? `[${m.via.slice(0, 22)}]` : ""}: ${m.text}`) };
const jobOf = async (c: Client, id: string) => (await c.call("GET", `/__computers/jobs/${id}`)).json.job ?? (await c.call("GET", `/__jobs/${id}`)).json.job ?? null;

async function ensureComputer(c: Client) {
  const have = ((await c.call("GET", "/__computers/")).json.computers as any[] | undefined) ?? [];
  if (!have.some((x) => x.name === COMPUTER)) {
    const t = Date.now();
    const r = await c.call("POST", "/__computers/", { name: COMPUTER, label: "V research" });
    log("provision v-research (existing computers API)", { status: r.status, ms: Date.now() - t, desktop: r.json.computer?.desktop, err: r.json.error });
  }
  const v = await waitFor("v-research online", async () => (((await c.call("GET", "/__computers/")).json.computers as any[]) ?? []).find((x) => x.name === COMPUTER && x.state === "online"), 180_000, 1500);
  log("v-research online", { id: v.id, state: v.state, desktop: v.desktop, caps: v.capabilities?.length });
  // A goal loop needs a page to read: put the computer's own browser on a start page first (setup, through the same API; not a Jarvis step).
  const start = await c.call("POST", `/__computers/${COMPUTER}/jobs`, { agent: "journey-setup", steps: [{ executor: "browser.navigate", args: { url: "https://example.com", expectTitle: "Example Domain" }, timeoutMs: 60000 }] });
  if (start.status === 200) await waitFor("start page", async () => settled((await jobOf(c, start.json.jobId))?.state ?? ""), 90_000, 500);
  log("v-research start page", { status: start.status, state: start.status === 200 ? (await jobOf(c, start.json.jobId))?.state : start.json.error });
  return v;
}

// ---- journey a ------------------------------------------------------------------------------------------------------------------------
async function journeyA() {
  const c0 = await client();
  await ensureComputer(c0);
  await c0.close();
  // Two requests: a deterministic one (a typed, title-verified page step) and an open-ended one (the hub-side goal loop; ends on Jev's own confidence).
  const requests = [
    "open example.org and confirm that the title is Example Domain, on the v-research computer",
    "research Example Domains Pty Ltd by opening example.com and clicking the Learn more link, on the v-research computer",
  ];
  for (const said of requests) {
    let c = await client();
    const eventId = `utt-journey-a-${Date.now().toString(36)}`;
    const r = await c.command({ utterance: said, source: "voice", eventId, pageContext: { page: "/leads", title: "Leads", focused: { kind: "lead", id: "12", label: "Example Domains Pty Ltd" }, capturedAt: Date.now() } });
    log("a: voice command -> ack", { said, ok: r.done?.ok, ack: r.done?.said, jobId: r.done?.jobId, kind: r.done?.kind, stream: r.events.map((e) => e.type) });
    const jobId = r.done?.jobId as string;
    const mid = await jobOf(c, jobId);
    log("a: job right after the ack", { state: mid?.state, steps: mid?.steps?.length, contextStep: mid?.steps?.find((s: any) => s.executor === "context")?.intent });
    await c.close(); // the client / voice session ends mid-job
    log("a: client closed", { jobId: jobId.slice(0, 8) });
    await sleep(1500);
    c = await client(); // coming back: a NEW browser, the same signed-in profile
    const finished = await waitFor("job result entry in the conversation", async () => {
      const t = await thread(c);
      return t && t.messages.some((m: any) => m.text.includes(`(job ${jobId.slice(0, 8)}`) && /^(Finished|Failed|Stopped|Ended without): /.test(m.text)) ? t : null;
    }, 240_000, 2000);
    log("a: after coming back, the SAME conversation shows the result", { messagesForThisJob: brief(finished).messages.filter((m: string) => m.includes(jobId.slice(0, 8))) });
    const job = await jobOf(c, jobId);
    log("a: job record", { state: job?.state, note: job?.note, steps: job?.steps?.map((s: any) => `${s.outcome} ${s.executor}: ${s.intent.slice(0, 110)}`) });
    await c.close();
  }
  const c = await client();
  const events = (await c.call("GET", "/__operator/jarvis/events")).json;
  log("a: lines the interjection gate holds for the voice client to say at a pause", (events.events ?? []).filter((e: any) => e.source === "jarvis-job").map((e: any) => ({ text: e.text, delivery: e.delivery, reason: e.reason })));
  await c.close();
}
// ---- journey b ------------------------------------------------------------------------------------------------------------------------
function git(cwd: string, ...a: string[]) {
  const r = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function makeRepo() {
  rmSync(scratchRepo, { recursive: true, force: true });
  mkdirSync(join(scratchRepo, "src"), { recursive: true });
  git(scratchRepo, "init", "-q", "-b", "main");
  writeFileSync(join(scratchRepo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(scratchRepo, "package.json"), JSON.stringify({ name: "open-dot-v-throwaway", private: true, type: "module" }, null, 2) + "\n");
  writeFileSync(join(scratchRepo, "src", "greet.ts"), "export const greet = (name: string): string => `Hello, ${name}!`;\n");
  writeFileSync(join(scratchRepo, "src", "greet.test.ts"), 'import { expect, test } from "bun:test";\nimport { greet } from "./greet";\n\ntest("greet", () => {\n  expect(greet("Ada")).toBe("Hello, Ada!");\n});\n');
  writeFileSync(join(scratchRepo, "README.md"), "# Throwaway repo for an Open Dot V journey\nOnly src/greet.ts and src/greet.test.ts may change.\n");
  git(scratchRepo, "add", "-A");
  git(scratchRepo, "commit", "-q", "-m", "throwaway base");
  mkdirSync("D:/prog-scratch/open-dot-v-repo-wt", { recursive: true });
  const registry = { version: 1, repos: [{ id: "throwaway", description: "throwaway repo for an Open Dot V journey", canonicalPath: scratchRepo, defaultBaseRef: "main", worktreeParent: "D:/prog-scratch/open-dot-v-repo-wt", protectedBranches: ["main", "master", "production"], remotes: [], commands: [{ id: "tw.test", kind: "test", argv: ["bun", "--no-env-file", "test"], cwd: ".", timeoutMs: 120000, counts: "bun" }], nodeModules: "none", allowedPeople: ["usman", "mehroz"] }] };
  writeFileSync(join(data, "coding", "repos.json"), JSON.stringify(registry, null, 2));
}
async function journeyB() {
  makeRepo();
  log("b: throwaway repo registered (isolated registry; the live registry is untouched)", { repo: scratchRepo });
  let c = await client();
  const say = async (utterance: string, extra: Record<string, unknown> = {}) => {
    const r = await c.command({ utterance, source: "typed", eventId: `utt-journey-b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...extra });
    log(`b: "${utterance}"`, { ok: r.done?.ok, said: r.done?.said, jobId: r.done?.jobId, codingJobId: r.done?.numbers?.codingJobId, state: r.done?.numbers?.codingJobState });
    return r.done;
  };
  let d = await say("assign a builder on Claude Max 2 to add an exported farewell function to src/greet.ts in the throwaway repo that returns Goodbye, name!, with a test in src/greet.test.ts; one Sonnet builder and an Opus reviewer");
  for (let i = 0; i < 4 && !d?.numbers?.codingJobId; i++) d = await say(i === 0 ? "the throwaway repo" : "yes");
  if (!d?.numbers?.codingJobId) throw new Error("no coding draft was produced");
  const codingJobId = d.numbers.codingJobId as string;
  d = await say("start it");
  log("b: thread after start", brief(await thread(c)));
  await c.close(); // the client leaves; the job is the server's
  c = await client();
  const final = await waitFor("coding result in the conversation", async () => {
    const t = await thread(c);
    return t && t.messages.some((m: any) => /^(Finished|Failed|Stopped|Ended without|Waiting for you): /.test(m.text) && m.text.includes(codingJobId.slice(0, 8))) ? t : null;
  }, 30 * 60_000, 5000);
  log("b: after coming back, the SAME conversation shows the coding result", brief(final));
  const job = (await c.call("GET", `/__operator/coding/jobs/${codingJobId}`)).json;
  log("b: coding job receipts (account and the model that actually answered)", { state: job.job?.state, receipts: (job.receipts ?? []).map((r: any) => ({ task: r.task, account: r.account, requested: r.requestedModel ?? r.model, providerModel: r.providerModel, mismatch: r.modelMismatch, outcome: r.outcome })), modelsUsed: job.modelsUsed });
  await c.close();
}

// ---- journeys c / d / f ---------------------------------------------------------------------------------------------------------------
async function journeyC() {
  const c = await client();
  await ensureComputer(c);
  const startedAt = Date.now() - 2000;
  const eventId = `utt-journey-c-${Date.now().toString(36)}`;
  const body = { utterance: "research Example Domains Pty Ltd by opening example.org and saying what it is, on the v-research computer", source: "voice", eventId };
  // The first send; the voice channel drops mid-stream (aborted after 1.5 s), then reconnects and the SAME utterance event is replayed (twice).
  const first = await c.command(body, { abortAfterMs: 1500 });
  log("c: first send, stream dropped", { aborted: first.aborted, gotDone: !!first.done, events: first.events.map((e) => e.type) });
  await c.close();
  const c2 = await client();
  const replay = await c2.command(body);
  const replay2 = await c2.command(body);
  log("c: replays after the reconnect", { first: first.done?.jobId, replay: replay.done?.jobId, replay2: replay2.done?.jobId, saidSame: replay.done?.said === replay2.done?.said });
  const jobs = (((await c2.call("GET", "/__operator/jobs")).json.jobs ?? (await c2.call("GET", "/__jobs")).json.jobs) as any[] | undefined) ?? [];
  const mine = jobs.filter((j) => /example.org and saying/.test(j.title) && Date.parse(j.createdAt) >= startedAt);
  log("c: jobs for that utterance in the job log", { count: mine.length, ids: mine.map((j) => j.id.slice(0, 8)), states: mine.map((j) => j.state) });
  await c2.close();
}
/**
 * A job that stays running long enough to talk about: a plain computer job through the computers API (a wait step, then a page step that must NOT run
 * if it is stopped). It is then brought into the person's Jarvis thread through the command path ("show me the v-research computer" answers with its job).
 */
async function longJob(c: Client, waitMs: number) {
  const r = await c.call("POST", `/__computers/${COMPUTER}/jobs`, { agent: "journey-long", steps: [{ executor: "wait", args: { ms: waitMs }, timeoutMs: waitMs + 20000 }, { executor: "browser.navigate", args: { url: "https://example.net", expectTitle: "Example Domain" }, timeoutMs: 60000 }] });
  if (r.status !== 200) throw new Error(`long job refused: ${r.json.error}`);
  const id = r.json.jobId as string;
  await waitFor("long job running", async () => (await jobOf(c, id))?.state === "running", 30_000, 300);
  return id;
}
const say = async (c: Client, utterance: string) => {
  const r = await c.command({ utterance, source: "voice", eventId: `utt-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}` });
  log(`"${utterance}"`, { ok: r.done?.ok, said: r.done?.said, jobId: r.done?.jobId?.slice?.(0, 8), stopped: r.done?.stopped, ask: r.done?.ask });
  return r.done;
};
async function journeyD() {
  const c = await client();
  await ensureComputer(c);
  const id = await longJob(c, 25_000);
  log("d: a computer job is running", { jobId: id.slice(0, 8) });
  await say(c, "show me the v-research computer"); // answers with the running job: it joins the thread
  const q1 = await say(c, "how's that going?");
  const q2 = await say(c, "how's the v-research job going?");
  const more = await say(c, "also confirm the title says Example Domain");
  const job = await jobOf(c, id);
  log("d: answers come from the real job state; context was added to the same job (no second job)", { statusJob: q1?.jobId?.slice?.(0, 8), topicalJob: q2?.jobId?.slice?.(0, 8), attachedTo: more?.jobId?.slice?.(0, 8), same: [q1?.jobId, q2?.jobId, more?.jobId].every((x) => x === id), contextSteps: job.steps.filter((s: any) => s.executor === "context").map((s: any) => s.intent.slice(0, 120)) });
  await say(c, "stop that task");
  await waitFor("settled", async () => settled((await jobOf(c, id))?.state ?? ""), 60_000, 500);
  log("d: thread", brief(await thread(c)).jobs.slice(-1));
  await c.close();
}
async function journeyF() {
  const c = await client();
  await ensureComputer(c);
  const id = await longJob(c, 20_000);
  await say(c, "show me the v-research computer");
  const before = (await jobOf(c, id)).steps.length;
  const t = Date.now();
  const stop = await say(c, "stop that task");
  await waitFor("job settled", async () => settled((await jobOf(c, id))?.state ?? ""), 60_000, 300);
  const settledMs = Date.now() - t;
  await sleep(25_000); // far longer than the wait it was in: if the next step were going to run it would have by now
  const job = await jobOf(c, id);
  const nav = job.steps.filter((s: any) => /browser.navigate|example.net/.test(`${s.action ?? ""} ${s.intent}`) && s.outcome === "ok");
  log("f: after the stop", { said: stop?.said, state: job.state, settledMs, stepsBefore: before, steps: job.steps.map((s: any) => `${s.outcome} ${s.executor}${s.action ? " " + s.action : ""}: ${s.intent.slice(0, 80)}`), laterStepsThatRan: nav.length });
  log("f: thread entries for this job", (await thread(c)).messages.filter((m: any) => m.text.includes(id.slice(0, 8))));
  await c.close();
}

async function down() {
  try {
    const c = await client();
    const have = ((await c.call("GET", "/__computers/")).json.computers as any[] | undefined) ?? [];
    if (have.some((x) => x.name === COMPUTER)) {
      const r = await c.call("POST", `/__computers/${COMPUTER}/action`, { action: "destroy" });
      log("destroy v-research (owned cleanup via the API)", { status: r.status, body: JSON.stringify(r.json).slice(0, 200) });
    }
    await c.close();
  } catch (e) {
    log("destroy failed", String((e as Error).message));
  }
  const pid = existsSync(join(out, "hub.pid")) ? Number(readFileSync(join(out, "hub.pid"), "utf8")) : 0;
  if (pid) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    rmSync(join(out, "hub.pid"), { force: true });
    log("hub stopped (own PID tree)", { pid });
  }
}

const table: Record<string, () => Promise<void>> = { up, a: journeyA, b: journeyB, c: journeyC, d: journeyD, f: journeyF, down };
if (!table[cmd]) {
  console.error("usage: up | a | b | c | d | f | down");
  process.exit(2);
}
await table[cmd]();
process.exit(0);
