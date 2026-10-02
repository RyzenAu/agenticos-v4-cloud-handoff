/**
 * REAL smokes for the coding harness (CODING-HARNESS §7 C3/C4). Owner-run, never in CI, never looped:
 * refuses to run unless CODING_LIVE_SMOKE=1. Everything happens in a SYNTHETIC temp repo under
 * CODING_SMOKE_DIR (default D:\agent-scratch\t3\live-smoke-<time>); the live checkout is only snapshotted
 * (it must be byte-identical afterwards).
 *
 *   claude   one job: a Claude Opus builder edits ONE owned file, the orchestrator runs the check, an
 *            Opus reviewer reviews the exact sha, the done gate decides. Real receipts are printed.
 *   codex    the same job with a Codex builder, through the harness (A1-6 preflight applies).
 *   claude2  (1 Oct 2026) one job on the account named by CODING_SMOKE_SLOT (default claude:max-2, read from
 *            CODING_ACCOUNTS_FILE), a Sonnet 5.5 builder and a DIFFERENT-model reviewer (CODING_SMOKE_REVIEWER,
 *            default claude-opus-5-5), in a throwaway repo whose check is a real `bun test`. The shared brief
 *            (CODING_SHARED_CONTEXT_FILE) is injected exactly as the OS does. Nothing is merged or pushed.
 *            CODING_SMOKE_TASK=bugfix runs it as a BUG FIX on a seeded repo with a real reproducible symptom (2 Oct 2026, track K):
 *            the engineering guidance (guidance.ts) is delivered to each role and named in the receipts.
 *   resume   Codex thread/resume after an app-server restart: a text-only turn (every command denied by
 *            policy, read-only sandbox), the app-server exits, a NEW app-server resumes the same thread.
 *
 *   CODING_LIVE_SMOKE=1 bun scripts/coding/live-smoke.ts claude|codex|resume
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_ACCOUNTS, loadAccounts } from "./accounts";
import { loadSharedContext } from "./shared-context";
import type { ClaudeAccountSlot, ClaudeModelId } from "./contracts";
import type { RepoRegistry, RepoRegistryEntry, Uuid } from "./contracts";
import { withGuidance } from "./guidance";
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

/** The throwaway repo for the claude2 job: a tiny TypeScript module with a REAL bun test as the check. */
function bunRepo(): RepoRegistryEntry {
  const canonical = join(base, "canonical");
  mkdirSync(join(canonical, "src"), { recursive: true });
  gitIn(canonical, "init", "-q", "-b", "main");
  writeFileSync(join(canonical, ".gitignore"), "node_modules/\n");
  writeFileSync(join(canonical, "package.json"), JSON.stringify({ name: "prog-d-throwaway", private: true, type: "module" }, null, 2) + "\n");
  writeFileSync(join(canonical, "src", "greet.ts"), 'export const greet = (name: string): string => `Hello, ${name}!`;\n');
  writeFileSync(join(canonical, "src", "greet.test.ts"), 'import { expect, test } from "bun:test";\nimport { greet } from "./greet";\n\ntest("greet", () => {\n  expect(greet("Ada")).toBe("Hello, Ada!");\n});\n');
  writeFileSync(join(canonical, "README.md"), "# Throwaway repo for a harness job\nOnly src/greet.ts and src/greet.test.ts may change.\n");
  gitIn(canonical, "add", "-A");
  gitIn(canonical, "commit", "-q", "-m", "throwaway base");
  mkdirSync(join(base, "wt"), { recursive: true });
  return {
    id: "throwaway" as never, description: "throwaway repo for a harness job", canonicalPath: canonical, defaultBaseRef: "main", worktreeParent: join(base, "wt"),
    protectedBranches: ["main", "master", "production"], remotes: [],
    commands: [{ id: "tw.test" as never, kind: "test", argv: ["bun", "--no-env-file", "test"], cwd: ".", timeoutMs: 120_000, counts: "bun" }],
    nodeModules: "none", allowedPeople: ["usman" as never],
  };
}

/** A throwaway TypeScript repo with a REAL, reproducible bug: the GST line of a GST-inclusive invoice (symptom: scripts/symptom.ts). */
function bugRepo(): RepoRegistryEntry {
  const canonical = join(base, "canonical");
  mkdirSync(join(canonical, "src"), { recursive: true });
  mkdirSync(join(canonical, "scripts"), { recursive: true });
  gitIn(canonical, "init", "-q", "-b", "main");
  const put = (path: string, lines: string[]) => writeFileSync(join(canonical, path), `${lines.join("\n")}\n`);
  put(".gitignore", ["node_modules/"]);
  put("package.json", [JSON.stringify({ name: "prog-k-invoice", private: true, type: "module" }, null, 2)]);
  put("AGENTS.md", [
    "# Invoice library",
    "",
    "- Money is always integer cents. Never use floating-point dollars.",
    "- Every rounding goes through `roundCents` in src/money.ts; do not call Math.round on money anywhere else.",
    "- Tests live beside the code as `*.test.ts` and call the public functions only.",
  ]);
  put("README.md", ["# Invoice library (throwaway repo for a harness job)", "", "Run the symptom: `bun scripts/symptom.ts`."]);
  put("src/money.ts", [
    "/** The one place money is rounded: half away from zero, to whole cents. */",
    "export const roundCents = (value: number): number => Math.sign(value) * Math.round(Math.abs(value));",
    "",
    "export const formatMoney = (cents: number): string => `$${(cents / 100).toFixed(2)}`;",
  ]);
  put("src/invoice.ts", [
    'import { formatMoney, roundCents } from "./money";',
    "",
    "export type Line = { sku: string; unitCents: number; qty: number; discountPct?: number };",
    "export type Summary = { totalCents: number; gstCents: number; text: string };",
    "",
    "/** The line's price in cents after its percentage discount. Prices are GST-inclusive. */",
    "export function lineTotalCents(line: Line): number {",
    "  const gross = line.unitCents * line.qty;",
    "  return roundCents(gross - (gross * (line.discountPct ?? 0)) / 100);",
    "}",
    "",
    "/** Totals for an invoice. Australian GST is 10%, and every price here already includes it. */",
    "export function invoiceSummary(lines: readonly Line[]): Summary {",
    "  const totalCents = lines.reduce((sum, line) => sum + lineTotalCents(line), 0);",
    "  const gstCents = roundCents(totalCents * 0.1);",
    "  return { totalCents, gstCents, text: `Total ${formatMoney(totalCents)} (includes GST ${formatMoney(gstCents)})` };",
    "}",
  ]);
  put("src/invoice.test.ts", [
    'import { expect, test } from "bun:test";',
    'import { lineTotalCents } from "./invoice";',
    "",
    'test("a discounted line is priced in whole cents", () => {',
    '  expect(lineTotalCents({ sku: "A", unitCents: 1999, qty: 3, discountPct: 10 })).toBe(5397);',
    "});",
    "",
    'test("a line with no discount is unit price times quantity", () => {',
    '  expect(lineTotalCents({ sku: "B", unitCents: 500, qty: 2 })).toBe(1000);',
    "});",
  ]);
  put("scripts/symptom.ts", [
    'import { invoiceSummary } from "../src/invoice";',
    "",
    "// The customer's invoice: one line, 11000 cents ($110.00) GST-inclusive. Their accountant says the GST inside it is $10.00.",
    'const s = invoiceSummary([{ sku: "CONSULT-1H", unitCents: 11000, qty: 1 }]);',
    "console.log(s.text);",
    'process.exit(s.text === "Total $110.00 (includes GST $10.00)" ? 0 : 1);',
  ]);
  gitIn(canonical, "add", "-A");
  gitIn(canonical, "commit", "-q", "-m", "invoice library base");
  mkdirSync(join(base, "wt"), { recursive: true });
  return {
    id: "invoice" as never, description: "throwaway invoice library for a harness bug fix", canonicalPath: canonical, defaultBaseRef: "main", worktreeParent: join(base, "wt"),
    protectedBranches: ["main", "master", "production"], remotes: [],
    commands: [{ id: "inv.test" as never, kind: "test", argv: ["bun", "--no-env-file", "test"], cwd: ".", timeoutMs: 120_000, counts: "bun" }],
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
    runners: { claude: withGuidance(claudeRunner()), codex: withGuidance(codexRunner()), router: withGuidance(routerRunner()) },
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

async function claude2() {
  const slot = (process.env.CODING_SMOKE_SLOT ?? "claude:max-2") as ClaudeAccountSlot;
  const reviewerModel = (process.env.CODING_SMOKE_REVIEWER ?? "claude-opus-5-5") as ClaudeModelId;
  const builderModel = (process.env.CODING_SMOKE_BUILDER ?? "claude-sonnet-5-5") as ClaudeModelId;
  const accountsFile = process.env.CODING_ACCOUNTS_FILE;
  if (!accountsFile) throw new Error("Set CODING_ACCOUNTS_FILE to the accounts.json that names the slot (it is only read).");
  const accounts = loadAccounts(accountsFile);
  if (!accounts.claude.some((c) => c.slot === slot)) throw new Error(`${slot} is not in ${accountsFile}`);
  if (slot === "claude:max") throw new Error("Refusing claude:max (its weekly window is full; this smoke is for the second account).");
  const sharedFile = process.env.CODING_SHARED_CONTEXT_FILE;
  const bugfix = process.env.CODING_SMOKE_TASK === "bugfix";
  const entry = bugfix ? bugRepo() : bunRepo();
  const registry: RepoRegistry = { version: 1, repos: [entry] };
  const store = CodingStore.open(join(base, "coding-data"));
  const liveBefore = canonicalSnapshot(LIVE_ROOT);
  const orch = createOrchestrator({
    store, registry: () => registry, accounts: () => accounts,
    runners: { claude: withGuidance(claudeRunner()), codex: withGuidance(codexRunner()), router: withGuidance(routerRunner()) },
    approvals: () => null, liveRoot: LIVE_ROOT, memory: null, fleetSink: null, inputTimeoutMs: 60_000,
    wallMsFor: () => 15 * 60_000,
    sharedContext: () => (sharedFile ? loadSharedContext(sharedFile) : null),
  });
  const spec = bugfix ? draftSpec({
    requestedBy: OWNER, channel: "typed", utterance: "Fix this bug: the GST on our invoices is wrong.", entry,
    objective: "Fix the bug where an invoice's GST line is wrong: a GST-inclusive $110.00 invoice says it includes GST $11.00, but it should say $10.00 (`bun scripts/symptom.ts` shows it and exits 1 until fixed).",
    nonGoals: ["No refactors or renames", "Do not change how lines are priced"],
    doneWhen: [
      { id: "c1", text: "`bun scripts/symptom.ts` prints 'Total $110.00 (includes GST $10.00)' and exits 0", evidence: "reviewer-confirms" },
      { id: "c2", text: "a regression test in src/invoice.test.ts covers the GST of a GST-inclusive invoice and inv.test passes", evidence: "test", ref: "inv.test" },
    ],
    roleTemplate: "build+review",
    builders: [{ binding: claudeBinding(builderModel, "live", slot), owns: { globs: ["src/invoice.ts", "src/invoice.test.ts", "src/money.ts"], newFiles: [] } }],
    reviewer: { binding: claudeBinding(reviewerModel, "live", slot) },
    checks: ["inv.test" as never], dataClass: "synthetic",
  }) : draftSpec({
    requestedBy: OWNER, channel: "typed", utterance: "throwaway: add a farewell function with a test", entry,
    objective: 'In src/greet.ts add an exported function farewell(name: string): string that returns `Goodbye, ${name}!` (keep greet unchanged), and add a test for it in src/greet.test.ts.',
    nonGoals: ["No other files", "Do not change greet"],
    doneWhen: [
      { id: "c1", text: "src/greet.ts exports farewell(name) returning Goodbye, <name>!", evidence: "reviewer-confirms" },
      { id: "c2", text: "src/greet.test.ts tests farewell and tw.test passes", evidence: "test", ref: "tw.test" },
    ],
    roleTemplate: "build+review",
    builders: [{ binding: claudeBinding(builderModel, "live", slot), owns: { globs: ["src/greet.ts", "src/greet.test.ts"], newFiles: [] } }],
    reviewer: { binding: claudeBinding(reviewerModel, "live", slot) },
    checks: ["tw.test" as never], dataClass: "synthetic",
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
    if (Date.now() - t0 > 30 * 60_000) { orch.cancel(drafted.id); break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const done = store.getJob(drafted.id)!;
  const receipts = store.events(drafted.id, 0, 5000).filter((e) => e.type === "usage").map((e) => e.payload);
  const liveAfter = canonicalSnapshot(LIVE_ROOT);
  console.log(JSON.stringify({
    jobId: done.id, state: done.state, head: done.headSha, gate: done.gate, diff: done.diff, tests: done.tests.map((t) => ({ sha: t.sha, exitCode: t.exitCode, counts: t.counts })),
    review: done.review && { verdict: done.review.verdict, findings: done.review.findings, criteria: done.review.criteria },
    runs: done.runs.map((r) => ({ roleId: r.roleId, state: r.state, account: r.binding.accountSlot, requested: r.binding.model, session: r.nativeSessionId, error: r.error })),
    receipts, liveCheckoutUntouched: sameSnapshot(liveBefore, liveAfter), canonicalStatus: gitIn(entry.canonicalPath, "status", "--porcelain").trim(),
    patch: done.headSha ? gitIn(entry.canonicalPath, "diff", done.diff?.baseSha ?? "main", done.headSha) : null,
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
else if (which === "claude2") await claude2();
else if (which === "resume") await resumeProbe();
else console.error("claude | claude2 | codex | resume");
