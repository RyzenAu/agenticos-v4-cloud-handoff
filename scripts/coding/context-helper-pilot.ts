/**
 * Context-helper pilot driver (programme CM, 1 Oct 2026). Owner-run, never in CI.
 *
 *   bun scripts/coding/context-helper-pilot.ts gen <dir>                      synthetic repo + gold answers (no Claude)
 *   CODING_LIVE_SMOKE=1 bun scripts/coding/context-helper-pilot.ts run <dir> <A|B> <on|off> <out.json>
 *                                                                              ONE real Claude run through claudeRunner
 *   bun scripts/coding/context-helper-pilot.ts mcp <dir> <name>               scripted MCP demos (no Claude)
 *
 * `run` uses the harness's own claudeRunner and createPolicy (so the real argv, the real `--restricted`, the
 * real policy), on the account slot's profile named by PILOT_CONFIG_DIR (never read or modified here). It
 * records usage per model turn, the bytes of every tool result the model saw, and every policy decision.
 * Escalations are answered "deny" (headless), and counted.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeRunner } from "./runners/claude";
import { createPolicy } from "./runners/policy";
import type { PolicyFn, RunnerEvent } from "./runners/types";
import type { ClaudeModelId, CommandId } from "./contracts";
import { claudeBinding } from "./spec";

const [, , cmd, dir, ...rest] = process.argv;

// ───────────────────────── fixture ─────────────────────────

function gen(root: string) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "repo", "src", "billing"), { recursive: true });
  const repo = join(root, "repo");
  const w = (p: string, s: string) => writeFileSync(join(repo, p), s);
  // 300 filler modules; ~3 calls of legacyFormat each (B's flood); one odd call site with 'EUR-SPECIAL'.
  let calls = 0, odd = "";
  for (let i = 1; i <= 300; i++) {
    const n = String(i).padStart(3, "0");
    const lines = [`// module ${n}`, `const { legacyFormat } = require("./billing/format");`, `function f${n}(x) {`, `  const a = legacyFormat(x, 'USD');`, calls >= 0 && i % 2 === 0 ? `  const b = legacyFormat(x * 2, 'AUD');` : `  const b = x;`, `  return a + b;`, `}`];
    calls += 1 + (i % 2 === 0 ? 1 : 0);
    if (i === 187) { lines.splice(6, 0, `  const c = legacyFormat(x, 'EUR-SPECIAL'); // odd one`); calls += 1; odd = `src/mod${n}.js:7`; }
    lines.push(`module.exports = { f${n} };`, "");
    w(`src/mod${n}.js`, lines.join("\n"));
  }
  w("src/billing/format.js", "exports.legacyFormat = (x, cur) => `${cur} ${x}`;\n");
  // The bug: line 41 of invoice.js floors above 1000.
  const pad = Array.from({ length: 36 }, (_, i) => `// invoice helper ${i + 1}`).join("\n");
  w("src/billing/invoice.js", `// invoice rounding\n${pad}\nexports.roundCents = function roundCents(x) {\n  if (x >= 1000) return Math.floor(x * 100) / 100; // BUG: floors large amounts\n  return Math.round(x * 100) / 100;\n};\n`);
  w("test.js", `const { roundCents } = require("./src/billing/invoice");
let pass = 0, fail = 0;
for (let i = 1; i <= 3000; i++) {
  const amount = Number((i * 0.9 + (i % 97 === 0 ? 0.005 : 0)).toFixed(3));
  const want = Number((Math.round(amount * 100) / 100).toFixed(2));
  const got = roundCents(amount);
  if (Math.abs(got - want) < 1e-9) { pass++; console.log("ok " + i + " roundCents(" + amount + ") = " + got); }
  else { fail++; console.log("FAIL case " + i + " amount=" + amount + " expected " + want + " got " + got + "\\n    at roundCents (src/billing/invoice.js:41:" + (12 + (i % 5)) + ")\\n    at runCase (test.js:" + (6 + (i % 3)) + ":3)"); }
}
console.log("\\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
`);
  w("typecheck.js", `// simulated tsc output: lots of TS6133 noise, exactly one real error
const lines = [];
for (let i = 1; i <= 1800; i++) {
  const m = String(1 + (i % 300)).padStart(3, "0");
  if (i === 1203) lines.push("src/billing/invoice.js(212,17): error TS2741: Property 'currency' is missing in type '{ amount: number; }' but required in type 'Money'.");
  else lines.push("src/mod" + m + ".js(" + (3 + (i % 40)) + "," + (5 + (i % 9)) + "): error TS6133: 'tmp" + i + "' is declared but its value is never read.");
}
console.log(lines.join("\\n"));
console.log("\\nFound 1800 errors in 301 files.");
process.exit(2);
`);
  w("README.md", "# Pilot fixture\nsrc/billing owns the rounding bug. test.js and typecheck.js are the checks.\n");
  w(".gitignore", "node_modules/\n");
  const ident = ["-c", "user.name=Pilot", "-c", "user.email=pilot@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
  const g = (...a: string[]) => { const r = spawnSync("git", [...ident, ...a], { cwd: repo, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "-m", "pilot base");
  // Gold answers from a real pristine run.
  const t = spawnSync("node", ["test.js"], { cwd: repo, encoding: "utf8" });
  const log = t.stdout.split("\n");
  const firstFail = log.find((l) => l.startsWith("FAIL case"))!;
  const lineNo = log.indexOf(firstFail) + 1;
  const summary = log.filter((l) => /passed, \d+ failed/.test(l))[0];
  const gold = { firstFailLine: firstFail, outputLineNumberOfFirstFail: lineNo, totalOutputLines: log.length, summary, testOutputBytes: t.stdout.length, typecheckRealError: "src/billing/invoice.js(212,17): error TS2741", legacyFormatCallSites: calls, oddCallSite: odd, bugLine: "src/billing/invoice.js:41" };
  writeFileSync(join(root, "gold.json"), JSON.stringify(gold, null, 2));
  console.log(JSON.stringify(gold, null, 2));
}

// ───────────────────────── tasks ─────────────────────────

const TASKS: Record<string, { prompt: string; ask: string }> = {
  A: {
    prompt: [
      "This repo has a failing check. Run `node test.js` and find out why it fails, then fix the bug in src/billing (you own src/billing/**; do not edit anything else) and re-run `node test.js` to confirm it passes.",
      "Then run `node typecheck.js` and tell me the one real error (ignore TS6133 noise): file, line, column and code.",
      "Do not commit. Finish with a short report that states: (1) the root cause and the file:line you fixed, (2) the typecheck error, and (3) the exact first failing case number and the exact `at roundCents (...)` location text it printed in your FIRST test run, answered from what you saw then (the bug is fixed now, so do not expect to reproduce it).",
    ].join("\n"),
    ask: "A",
  },
  B: {
    prompt: [
      "Audit use of the deprecated `legacyFormat(` helper across src/. Tell me (1) the total number of call sites in src/ (not counting its definition), and (2) the one file and line where it is called with the argument 'EUR-SPECIAL'.",
      "Do not edit anything. Then, as a second part, run `node typecheck.js` and report only the single real error (file, line, column, code), ignoring TS6133 noise.",
      "Finish with a short report. Include in it the exact line you found for the 'EUR-SPECIAL' call, quoted as it appears in the file.",
    ].join("\n"),
    ask: "B",
  },
};

// ───────────────────────── run ─────────────────────────

async function run(root: string, taskKey: string, mode: string, out: string) {
  if (process.env.CODING_LIVE_SMOKE !== "1") throw new Error("Refusing: set CODING_LIVE_SMOKE=1 (a real, allowance-spending run).");
  const configDir = process.env.PILOT_CONFIG_DIR;
  if (!configDir) throw new Error("PILOT_CONFIG_DIR (the account slot's profile folder) is required.");
  const task = TASKS[taskKey];
  const work = join(root, `wt-${taskKey}-${mode}`);
  rmSync(work, { recursive: true, force: true });
  cpSync(join(root, "repo"), work, { recursive: true });
  const model = (process.env.PILOT_MODEL ?? "claude-sonnet-5-5") as ClaudeModelId;
  const base = createPolicy({
    role: "builder", access: "write", worktree: work, owns: { globs: ["src/billing/**"], newFiles: [] },
    commands: [
      { id: "pilot.test" as CommandId, kind: "test", argv: ["node", "test.js"], cwd: ".", timeoutMs: 120_000, counts: "none" },
      { id: "pilot.typecheck" as CommandId, kind: "typecheck", argv: ["node", "typecheck.js"], cwd: ".", timeoutMs: 120_000, counts: "none" },
    ],
    nodeModules: "none", mayChangeDependencies: false, allowWeb: false, protectedRoots: [join(root, "repo")],
  });
  const decisions: { tool: string; decision: string; rule: string; target: string }[] = [];
  let escalations = 0;
  const policy: PolicyFn = (req) => { const v = base(req); return v; };
  const events: RunnerEvent[] = [];
  // Tee the stream-json so every tool result's size and every turn's usage is measured.
  const turns: { input: number; cacheRead: number; cacheWrite: number; output: number }[] = [];
  const toolResultBytes: { bytes: number }[] = [];
  let resultMsg: Record<string, any> | null = null;
  let argvRecord: string[] = [];
  let startupMs: number | null = null;
  const t0 = Date.now();
  const teeSpawn = ((c: string, args: string[], o: any) => {
    argvRecord = args;
    const child = spawn(c, args, o);
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === "system" && m.subtype === "init" && startupMs === null) startupMs = Date.now() - t0;
          if (m.type === "assistant" && !m.parent_tool_use_id && m.message?.usage) { const u = m.message.usage; turns.push({ input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }); }
          if (m.type === "user" && Array.isArray(m.message?.content)) for (const b of m.message.content) if (b?.type === "tool_result") toolResultBytes.push({ bytes: JSON.stringify(b.content ?? "").length });
          if (m.type === "system" && m.subtype === "init") (teeSpawn as any).mcp = m.mcp_servers;
          if (m.type === "result") resultMsg = m;
        } catch { /* non-json */ }
      }
    });
    return child;
  }) as any;
  const handle = claudeRunner({ spawn: teeSpawn, tempDir: join(root, "tmp"), killGraceMs: 5000 }).start({
    jobId: `pilot-${taskKey}-${mode}`, roleId: "builder-1", role: "builder",
    binding: claudeBinding(model, "claude:max-2"), cwd: work, prompt: task.prompt,
    system: "You are a coding builder in a synthetic pilot repo. Work only inside your worktree. Be efficient.",
    readOnly: false, session: { mode: "new", id: crypto.randomUUID() },
    policy: (req) => { const v = policy(req); if (v.decision === "escalate") { escalations++; return { ...v, decision: "auto-deny" as const, message: v.message + " (headless pilot: escalations are denied)" }; } return v; },
    signal: new AbortController().signal,
    onEvent: (e) => { events.push(e); if (e.type === "policy") decisions.push({ tool: e.nativeKind, decision: e.verdict.decision, rule: e.verdict.rule, target: e.verdict.target }); },
    limits: { wallMs: 12 * 60_000, maxTurns: 30, inputTimeoutMs: 1000 }, stopAtWindowPercent: 95, creditsAllowed: false,
    claudeConfigDir: configDir,
    ...(mode === "on" ? { contextHelper: { kind: "context-mode" as const, dataDir: join(root, "cm-data", `${taskKey}`) } } : {}),
  });
  const outcome = await handle.done;
  const sum = (k: keyof (typeof turns)[0]) => turns.reduce((a, t) => a + t[k], 0);
  const record = {
    task: taskKey, mode, model, status: outcome.status, error: outcome.error, elapsedMs: Date.now() - t0, startupMs,
    cliVersion: outcome.cliVersion, providerModel: outcome.providerModel, turns: outcome.turns, valueUsdEquivalent: outcome.valueUsdEquivalent,
    usage: outcome.usage,
    perTurn: turns, peakContextTokens: Math.max(0, ...turns.map((t) => t.input + t.cacheRead + t.cacheWrite)),
    sumContextTokens: sum("input") + sum("cacheRead") + sum("cacheWrite"), sumOutputTokens: sum("output"),
    toolResults: { count: toolResultBytes.length, totalBytes: toolResultBytes.reduce((a, t) => a + t.bytes, 0), maxBytes: Math.max(0, ...toolResultBytes.map((t) => t.bytes)) },
    policyDecisions: decisions, escalationsDeniedHeadless: escalations, mcpServersAtInit: (teeSpawn as any).mcp ?? null,
    argvOptions: argvRecord.filter((a) => a.startsWith("--")), finalText: outcome.finalText,
  };
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ ...record, perTurn: undefined, policyDecisions: decisions.length, finalText: outcome.finalText.slice(0, 1500) }, null, 2));
}

// ───────────────────────── scripted MCP demos (no Claude) ─────────────────────────

async function mcp(root: string, name: string) {
  const { resolveContextMode, contextModeLaunch } = await import("./runners/context-helper");
  const res = resolveContextMode({}); if (!res.ok) throw new Error(res.reason);
  const worktree = join(root, `wt-${name}`);
  rmSync(worktree, { recursive: true, force: true });
  cpSync(join(root, "repo"), worktree, { recursive: true });
  const launch = contextModeLaunch({ request: { kind: "context-mode", dataDir: join(root, "cm-data", name) }, resolution: res, runtime: process.execPath, worktree, sessionId: crypto.randomUUID() });
  const cfg = JSON.parse(launch.mcpConfig).mcpServers["context-mode"];
  const child = spawn(cfg.command, cfg.args, { cwd: worktree, env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", id = 0; const pending = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d) => { buf += d; let i: number; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch { /* */ } } });
  const rpc = (method: string, params: unknown) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pilot", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = async (n: string, args: unknown) => (await rpc("tools/call", { name: n, arguments: args })).result?.content?.[0]?.text as string;
  const results: Record<string, unknown> = {};
  const raw = spawnSync("node", ["test.js"], { cwd: worktree, encoding: "utf8" }).stdout;
  const r1 = await call("ctx_batch_execute", { commands: [{ label: "test run 1", command: "node test.js" }], queries: ["FAIL case first failing roundCents location"] });
  results.a = { rawOutputBytes: raw.length, returnedBytes: r1.length, preview: r1.slice(0, 700) };
  const r2 = await call("ctx_search", { queries: ["first FAIL case roundCents invoice.js"], source: "test run 1" });
  results.b = { returnedBytes: r2.length, firstFailInResult: /FAIL case \d+[^\n]*/.exec(r2)?.[0] ?? null, atLine: /at roundCents[^\n]*/.exec(r2)?.[0] ?? null };
  child.stdin.end(); setTimeout(() => child.kill(), 500);
  writeFileSync(join(root, `mcp-${name}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

/** Opens one helper server exactly as the runner would (own data dir), returns a caller. */
async function openHelper(root: string, name: string, worktree: string) {
  const { resolveContextMode, contextModeLaunch } = await import("./runners/context-helper");
  const res = resolveContextMode({}); if (!res.ok) throw new Error(res.reason);
  const launch = contextModeLaunch({ request: { kind: "context-mode", dataDir: join(root, "cm-data", name) }, resolution: res, runtime: process.execPath, worktree, sessionId: crypto.randomUUID() });
  const cfg = JSON.parse(launch.mcpConfig).mcpServers["context-mode"];
  const child = spawn(cfg.command, cfg.args, { cwd: worktree, env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", id = 0; const pending = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d) => { buf += d; let i: number; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch { /* */ } } });
  const rpc = (method: string, params: unknown) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pilot", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { call: async (n: string, args: unknown) => (await rpc("tools/call", { name: n, arguments: args })).result?.content?.[0]?.text as string, close: () => { child.stdin.end(); setTimeout(() => child.kill(), 300); } };
}

/** Demo (b): exact detail retrieved later. Demo (d): two concurrent jobs, each sees only its own context. */
async function demos(root: string) {
  const out: Record<string, unknown> = {};
  const wtA = join(root, "wt-iso-A"), wtB = join(root, "wt-iso-B");
  for (const w of [wtA, wtB]) { rmSync(w, { recursive: true, force: true }); cpSync(join(root, "repo"), w, { recursive: true }); }
  rmSync(join(root, "cm-data"), { recursive: true, force: true });
  const [a, b] = await Promise.all([openHelper(root, "job-A", wtA), openHelper(root, "job-B", wtB)]);
  // Concurrent: each job indexes its own marker, then BOTH search for BOTH markers.
  await Promise.all([
    a.call("ctx_batch_execute", { commands: [{ label: "note A", command: "echo JOB-A-MARKER zebra-alpha-7731 failed at line 4242" }], queries: ["zebra"] }),
    b.call("ctx_batch_execute", { commands: [{ label: "note B", command: "echo JOB-B-MARKER yak-bravo-9915 failed at line 5151" }], queries: ["yak"] }),
  ]);
  const seen = async (h: typeof a, q: string) => { const t = await h.call("ctx_search", { queries: [q] }); return /JOB-[AB]-MARKER[^\n]*/.exec(t)?.[0] ?? null; };
  out.isolation = {
    jobA_findsOwn: await seen(a, "zebra-alpha-7731"), jobA_findsOther: await seen(a, "yak-bravo-9915"),
    jobB_findsOwn: await seen(b, "yak-bravo-9915"), jobB_findsOther: await seen(b, "zebra-alpha-7731"),
  };
  // Demo (b) on job A: a big log, then recall exact details several ways.
  const big = await a.call("ctx_batch_execute", { commands: [{ label: "test run 1", command: "node test.js" }], queries: ["FAIL"] });
  const gold = JSON.parse(readFileSync(join(root, "gold.json"), "utf8"));
  const tryQ = async (q: string[], extra: Record<string, unknown> = {}) => { const t = await a.call("ctx_search", { queries: q, ...extra }); return { queries: q, extra, bytes: t.length, hasGoldCase: t.includes(gold.firstFailLine), firstFailLines: [...t.matchAll(/FAIL case \d+/g)].map((m) => m[0]).slice(0, 6) }; };
  out.retrieve = {
    goldFirstFail: gold.firstFailLine, batchReturnedBytes: big.length, rawBytes: gold.testOutputBytes,
    tries: [await tryQ(["first FAIL case"]), await tryQ(["FAIL case 1139"]), await tryQ(["1139"]), await tryQ(["FAIL case 1139 amount=1025.1"], { source: "test run 1" }), await tryQ(["FAIL"], { sort: "timeline" })],
  };
  // ctx_execute with intent (finer sections).
  const ex = await a.call("ctx_execute", { language: "shell", code: "node test.js", intent: "FAIL case 1139" });
  out.executeWithIntent = { bytes: ex.length, mentionsCase1139: ex.includes("1139"), head: ex.slice(0, 600) };
  const s2 = await a.call("ctx_search", { queries: ["FAIL case 1139"], source: "execute:shell" });
  out.executeSearch = { bytes: s2.length, hasGoldCase: s2.includes(gold.firstFailLine), at: /at roundCents[^\n]*/.exec(s2)?.[0] ?? null };
  a.close(); b.close();
  writeFileSync(join(root, "demos.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

if (cmd === "gen") gen(resolve(dir));
else if (cmd === "demos") await demos(resolve(dir));
else if (cmd === "run") await run(resolve(dir), rest[0], rest[1], resolve(rest[2]));
else if (cmd === "mcp") await mcp(resolve(dir), rest[0] ?? "demo");
else { console.error("usage: gen|run|mcp"); process.exit(2); }
void existsSync; void readFileSync; void TASKS;
