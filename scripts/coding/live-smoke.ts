/**
 * REAL smokes for the coding harness (CODING-HARNESS §7 C3/C4). Owner-run, never in CI, never looped:
 * refuses to run unless CODING_LIVE_SMOKE=1. Everything happens in a SYNTHETIC temp repo under
 * CODING_SMOKE_DIR (default D:\agent-scratch\t3\live-smoke-<time>); the live checkout is only snapshotted
 * (it must be byte-identical afterwards).
 *
 *   claude   one job: a Claude Opus builder edits ONE owned file, the orchestrator runs the check, an
 *            Opus reviewer reviews the exact sha, the done gate decides. Real receipts are printed.
 *   codex    the same job with a Codex builder, through the harness (A1-6 preflight applies).
 *   resume   Codex thread/resume after an app-server restart: a text-only turn (every command denied by
 *            policy, read-only sandbox), the app-server exits, a NEW app-server resumes the same thread.
 *
 *   CODING_LIVE_SMOKE=1 bun scripts/coding/live-smoke.ts claude|codex|resume
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_ACCOUNTS } from "./accounts";
import type { RepoRegistry, RepoRegistryEntry, Uuid } from "./contracts";
import { createOrchestrator } from "./orchestrator";
import { buildReceipt } from "./receipts";
import { claudeRunner } from "./runners/claude";
import { codexRunner } from "./runners/codex";
import { routerRunner } from "./runners/router";
import type { RunnerEvent } from "./runners/types";
import { claudeBinding, codexBinding, draftSpec, specDigest } from "./spec";
import { CodingStore } from "./store";
import { canonicalSnapshot, sameSnapshot } from "./worktree";

if (process.env.CODING_LIVE_SMOKE !== "1") {
  console.error("Refusing: set CODING_LIVE_SMOKE=1 to run a REAL (paid-allowance) smoke. Never in CI, never looped.");
  process.exit(2);
}
const which = process.argv[2] ?? "claude";
const LIVE_ROOT = resolve(process.env.CODING_LIVE_ROOT ?? "C:/Users/Nebula PC/source/repos/AgenticOS-v4");
const base = process.env.CODING_SMOKE_DIR ?? `D:/agent-scratch/t3/live-smoke-${which}-${Date.now()}`;
const IDENT = ["-c", "user.name=Smoke Fixture", "-c", "user.email=smoke@example.invalid", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
const gitIn = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", [...IDENT, ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

function syntheticRepo(): RepoRegistryEntry {
  const canonical = join(base, "canonical");
  mkdirSync(join(canonical, "src"), { recursive: true });
  gitIn(canonical, "init", "-q", "-b", "main");
  writeFileSync(join(canonical, ".gitignore"), "node_modules/\n");
  writeFileSync(join(canonical, "src", "hello.txt"), "hello world\n");
  writeFileSync(join(canonical, "src", "other.txt"), "not yours\n");
  writeFileSync(join(canonical, "results.txt"), ["(pass) greeting present [1.00ms]", " 1 pass", " 0 fail", ""].join("\n"));
  writeFileSync(join(canonical, "README.md"), "# Synthetic smoke repo\nOnly src/hello.txt may change.\n");
  gitIn(canonical, "add", "-A");
  gitIn(canonical, "commit", "-q", "-m", "synthetic base");
  // Dirty work in the canonical checkout, as another agent would leave it: must stay untouched.
  writeFileSync(join(canonical, "README.md"), "# Synthetic smoke repo\nOnly src/hello.txt may change.\nunsaved note\n");
  mkdirSync(join(base, "wt"), { recursive: true });
  return {
    id: "smoke" as never, description: "synthetic smoke repo", canonicalPath: canonical, defaultBaseRef: "main", worktreeParent: join(base, "wt"),
    protectedBranches: ["main", "master", "production"], remotes: [],
    commands: [{ id: "smoke.test" as never, kind: "test", argv: ["findstr", "/r", "^.", "results.txt"], cwd: ".", timeoutMs: 120_000, counts: "bun" }],
    nodeModules: "none", allowedPeople: ["usman" as never],
  };
}

const OWNER = { personId: "usman" as never, via: "local" as const, deviceId: "usman-pc" as never, sessionId: "smoke" };

async function job(builder: "claude" | "codex") {
  const entry = syntheticRepo();
  const registry: RepoRegistry = { version: 1, repos: [entry] };
  const store = CodingStore.open(join(base, "coding-data"));
  const liveBefore = canonicalSnapshot(LIVE_ROOT);
  const orch = createOrchestrator({
    store, registry: () => registry, accounts: () => DEFAULT_ACCOUNTS,
    runners: { claude: claudeRunner(), codex: codexRunner(), router: routerRunner() },
    approvals: () => null, liveRoot: LIVE_ROOT, memory: null, fleetSink: null, inputTimeoutMs: 60_000,
    wallMsFor: () => 15 * 60_000,
  });
  const spec = draftSpec({
    requestedBy: OWNER, channel: "typed", utterance: `smoke: ${builder} builder edits src/hello.txt`, entry,
    objective: `Change the greeting in src/hello.txt to exactly "hello from ${builder}" (one line, keep the trailing newline)`,
    nonGoals: ["No other file changes"],
    doneWhen: [{ id: "c1", text: `src/hello.txt says "hello from ${builder}"`, evidence: "reviewer-confirms" }, { id: "c2", text: "smoke.test passes", evidence: "test", ref: "smoke.test" }],
    roleTemplate: "build+review",
    builders: [{ binding: builder === "claude" ? claudeBinding("claude-opus-5-5", "live") : codexBinding("gpt-6-astra", "codex:openai-2", "live", "low"), owns: { globs: ["src/hello.txt"], newFiles: [] } }],
    reviewer: { binding: claudeBinding("claude-opus-5-5", "live") },
    checks: ["smoke.test" as never], dataClass: "synthetic",
  });
  const { job: drafted, validation } = orch.draft(spec);
  console.log("validation:", JSON.stringify(validation));
  orch.confirmAndStart(drafted.id, OWNER, "typed", specDigest(spec));
  const t0 = Date.now();
  let last = 0;
  for (;;) {
    const j = store.getJob(drafted.id)!;
    for (const e of store.events(drafted.id, last, 500)) {
      last = e.seq;
      if (["state", "step", "policy", "error", "spoken", "gate"].includes(e.type)) console.log(`[${e.seq}] ${e.type} ${e.roleId ?? ""} ${JSON.stringify(e.payload).slice(0, 220)}`);
    }
    if (!orch.running(drafted.id) && ["completed", "needs_owner", "failed", "cancelled", "blocked_allowance", "interrupted"].includes(j.state)) break;
    if (Date.now() - t0 > 40 * 60_000) { orch.cancel(drafted.id); break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const done = store.getJob(drafted.id)!;
  const receipts = store.events(drafted.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload);
  const liveAfter = canonicalSnapshot(LIVE_ROOT);
  const canonicalAfter = gitIn(entry.canonicalPath, "status", "--porcelain");
  console.log(JSON.stringify({
    which: builder, jobId: done.id, state: done.state, head: done.headSha, gate: done.gate, diffFiles: done.diff?.files, review: done.review && { verdict: done.review.verdict, findings: done.review.findings.length },
    runs: done.runs.map((r) => ({ roleId: r.roleId, state: r.state, session: r.nativeSessionId, error: r.error })),
    receipts, liveCheckoutUntouched: sameSnapshot(liveBefore, liveAfter), canonicalDirtyKept: canonicalAfter.trim(),
  }, null, 2));
  orch.close();
  store.close();
}

async function resumeProbe() {
  const cwd = join(base, "probe");
  mkdirSync(cwd, { recursive: true });
  const binding = codexBinding("gpt-6-astra", "codex:openai-2", "live", "low");
  const denyAll = () => ({ decision: "auto-deny" as const, rule: "unclassified" as const, target: "probe", message: "This probe runs no commands and changes no files. Reply in text only." });
  const turn = async (session: { mode: "new"; id: string } | { mode: "resume"; id: string }, prompt: string) => {
    const events: RunnerEvent[] = [];
    // No shell tool at all: nothing can run in Codex's sandbox, so A1-6's exposure can't be exercised by the probe.
    const out = await codexRunner({ extraArgs: ["--disable", "shell_tool"] }).start({
      jobId: randomUUID(), roleId: "probe", role: "reviewer", binding, cwd, prompt, system: "Probe of thread persistence. Never run a command or read a file; answer in text only.", readOnly: true, session,
      policy: denyAll, signal: new AbortController().signal, onEvent: (e) => events.push(e), limits: { wallMs: 5 * 60_000, maxTurns: 3, inputTimeoutMs: 10_000 }, stopAtWindowPercent: 95, creditsAllowed: false,
    }).done;
    const receipt = buildReceipt({ requestId: randomUUID() as Uuid, parentRequestId: null, jobId: randomUUID() as Uuid, roleId: "probe" as never, role: "reviewer", turn: 1, person: "usman" as never, binding, dataClass: "synthetic", outcome: out, allowanceStart: (events.find((e) => e.type === "allowance") as { snapshot?: never } | undefined)?.snapshot ?? null, queueMs: 0 });
    return { out, receipt, policies: events.filter((e) => e.type === "policy").length };
  };
  const first = await turn({ mode: "new", id: "unused" }, "Reply with exactly the word: ok");
  console.log("first:", JSON.stringify({ status: first.out.status, thread: first.out.sessionId, text: first.out.finalText.slice(0, 80), model: first.out.providerModel, plan: first.out.accountPlan, commandsDenied: first.policies, error: first.out.error }));
  if (!first.out.sessionId) return console.log(JSON.stringify({ first: first.receipt }, null, 2));
  // The first app-server has exited (the runner stops it after the turn): this is a NEW process.
  const second = await turn({ mode: "resume", id: first.out.sessionId }, "What single word did you reply with in your previous turn? Reply with exactly: resumed <that word>");
  console.log("second:", JSON.stringify({ status: second.out.status, thread: second.out.sessionId, sameThread: second.out.sessionId === first.out.sessionId, text: second.out.finalText.slice(0, 80), model: second.out.providerModel, error: second.out.error }));
  console.log(JSON.stringify({ receipts: [first.receipt, second.receipt] }, null, 2));
}

mkdirSync(base, { recursive: true });
console.log(`SYNTHETIC smoke dir: ${base}`);
if (which === "claude" || which === "codex") await job(which);
else if (which === "resume") await resumeProbe();
else console.error("claude | codex | resume");
